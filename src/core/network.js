import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { HttpsProxyAgent } from 'https-proxy-agent';

const trusted = typeof tls.getCACertificates === 'function'
  ? [...tls.getCACertificates('default'), ...tls.getCACertificates('system')] : undefined;
export function safeError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const names = { ETIMEDOUT: '请求超时', ENOTFOUND: '域名解析失败', EAI_AGAIN: 'DNS 暂时失败', ECONNREFUSED: '连接被拒绝', ECONNRESET: '连接重置', ENETUNREACH: '网络不可达', EHOSTUNREACH: '主机不可达', BODY_TOO_LARGE: '响应超出大小限制', PROFILE_INVALID: 'CLI 代理配置无效', UNSUPPORTED: '当前路径未覆盖' };
  if (code.includes('CERT') || code.includes('TLS') || code.includes('SSL')) return 'TLS 证书或握手失败';
  return names[code] || (code && /^[A-Z_0-9]+$/.test(code) ? code : '请求失败');
}
export function request(url, { proxy = '', family = 0, timeout = 10000, maxBytes = 131072, signal } = {}) {
  return new Promise(resolve => {
    const started = performance.now(); let finished = false, timer, req;
    let dnsMs = null, tcpMs = null, tlsMs = null;
    let agent;
    const finish = result => {
      if (finished) return; finished = true; clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      agent?.destroy();
      resolve({ url, totalMs: Math.round((performance.now() - started) * 10) / 10, dnsMs, tcpMs, tlsMs, ...result });
    };
    const abort = () => { req?.destroy(Object.assign(new Error(), { code: 'ETIMEDOUT' })); };
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.username || u.password) throw Object.assign(new Error(), { code: 'UNSUPPORTED' });
      const options = { keepAlive: false, rejectUnauthorized: true, ...(trusted ? { ca: trusted } : {}) };
      agent = proxy ? new HttpsProxyAgent(proxy, options) : new https.Agent(options);
      req = https.get(u, { agent, rejectUnauthorized: true, ...(trusted ? { ca: trusted } : {}), ...(!proxy && family ? { family } : {}),
        headers: { 'User-Agent': 'ClaudeOjouNetwork/0.1 (independent network diagnostic)', 'Cache-Control': 'no-cache', 'Accept': '*/*' } }, res => {
        const parts = []; let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) { req.destroy(Object.assign(new Error(), { code: 'BODY_TOO_LARGE' })); return; }
          parts.push(chunk);
        });
        res.on('error', e => finish({ ok: false, status: res.statusCode || 0, error: safeError(e), body: '' }));
        res.on('end', () => finish({ ok: true, status: res.statusCode || 0, error: '', body: Buffer.concat(parts).toString('utf8') }));
      });
      req.on('socket', socket => {
        socket.once('lookup', () => { dnsMs = Math.round(performance.now() - started); });
        socket.once('connect', () => { tcpMs = Math.round(performance.now() - started); });
        socket.once('secureConnect', () => { tlsMs = Math.round(performance.now() - started); });
      });
      req.on('error', e => finish({ ok: false, status: 0, error: safeError(e), body: '' }));
      timer = setTimeout(abort, timeout);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch (e) { finish({ ok: false, status: 0, error: safeError(e), body: '' }); }
  });
}
export function publicIP(value, family = 0) {
  if (typeof value !== 'string') return '';
  const ip = value.trim(), kind = net.isIP(ip);
  if (!kind || (family && kind !== family)) return '';
  if (kind === 4) {
    const [a,b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return '';
  } else if (/^(::|::1|f[cd][\da-f]{2}:|fe[89ab][\da-f]:|ff[\da-f]{2}:)/i.test(ip)) return '';
  return kind === 6 ? new URL(`https://[${ip}]`).hostname.slice(1,-1) : ip;
}
export function parseTrace(body, expectedHost) {
  const data = Object.fromEntries(body.split(/\r?\n/).filter(line => /^[a-z_]+=/.test(line)).map(line => { const i = line.indexOf('='); return [line.slice(0,i),line.slice(i+1)]; }));
  const ip = publicIP(data.ip);
  if (!ip || data.h !== expectedHost || !Number.isFinite(Number(data.ts)) || !data.ts || data.visit_scheme !== 'https') return null;
  return { ip, family: net.isIP(ip), edgeCountry: data.loc || '', colo: data.colo || '' };
}
export async function echo(family, proxyFor, fetcher = request) {
  const urls = family === 4 ? ['https://api.ipify.org', 'https://ipv4.icanhazip.com'] : ['https://api6.ipify.org', 'https://ipv6.icanhazip.com'];
  let result;
  for (const url of urls) {
    try { result = await fetcher(url, { proxy: proxyFor(url), family, timeout: 8000 }); }
    catch { return { ip: '', family, status: 'error', error: 'CLI 代理配置无效', source: new URL(url).hostname }; }
    const ip = result.ok && result.status === 200 ? publicIP(result.body, family) : '';
    if (ip) return { ip, family, status: 'ok', error: '', source: new URL(url).hostname, totalMs: result.totalMs };
  }
  return { ip: '', family, status: 'error', error: result?.error || `IPv${family} 回显不可用`, source: 'echo' };
}
export async function geoLookup(ip, proxyFor, fetcher = request) {
  for (const [source, url] of [['ipwho.is', `https://ipwho.is/${encodeURIComponent(ip)}`], ['GeoJS', `https://get.geojs.io/v1/ip/geo/${encodeURIComponent(ip)}.json`]]) {
    try {
      const r = await fetcher(url, { proxy: proxyFor(url), timeout: 6000 });
      if (!r.ok || r.status !== 200) continue;
      const d = JSON.parse(r.body);
      if (d.success === false || d.ip !== ip || !d.country) continue;
      const clean = v => typeof v === 'string' ? v.slice(0, 160) : typeof v === 'number' ? String(v) : '';
      return { country: clean(d.country), countryCode: clean(d.country_code), region: clean(d.region), city: clean(d.city), asn: clean(d.connection?.asn ?? d.asn), isp: clean(d.connection?.isp ?? d.organization_name ?? d.organization), source, checkedAt: Date.now() };
    } catch { /* A metadata failure never discards a valid IP observation. */ }
  }
  return { country: '', city: '', source: '暂不可用', checkedAt: Date.now() };
}
