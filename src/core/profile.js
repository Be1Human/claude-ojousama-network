import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const NETWORK_KEYS = [
  'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'no_proxy', 'NO_PROXY',
  'ALL_PROXY', 'all_proxy', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CONFIG_DIR',
  'NODE_EXTRA_CA_CERTS', 'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CERT_STORE', 'NODE_TLS_REJECT_UNAUTHORIZED',
];
export function pickNetworkEnv(input = {}) {
  return Object.fromEntries(NETWORK_KEYS.filter(k => typeof input[k] === 'string').map(k => [k, input[k].slice(0, 8192)]));
}
export function redactProxy(value) {
  try { const u = new URL(value); return `${u.protocol}//${u.username || u.password ? '***@' : ''}${u.host}`; }
  catch { return value ? '无效代理地址' : '未设置显式代理'; }
}
export function bypassProxy(url, noProxy = '') {
  const u = new URL(url), hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return noProxy.split(/[\s,]+/).filter(Boolean).some(token => {
    if (token === '*') return true;
    token = token.toLowerCase();
    let h = token, p;
    if (token.startsWith('[')) { const m = token.match(/^\[([^\]]+)\](?::(\d+))?$/); if (!m) return false; [, h, p] = m; }
    else if ((token.match(/:/g) || []).length === 1) [h, p] = token.split(':');
    if (p && p !== port) return false;
    h = h.replace(/^\*?\./, '');
    return hostname === h || hostname.endsWith(`.${h}`);
  });
}
export function createProfile(env = {}, source = '应用启动环境 + Claude 用户配置') {
  env = pickNetworkEnv(env);
  const key = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'].find(k => env[k]);
  const proxy = key ? env[key] : '';
  let error = '', normalized = '';
  if (proxy) {
    try {
      const u = new URL(proxy);
      if (!['http:', 'https:'].includes(u.protocol)) error = 'Claude Code 不支持 SOCKS；请填写 HTTP(S) 代理端口。';
      else if (u.pathname !== '/' || u.search || u.hash) error = '代理 URL 只能包含协议、主机、端口和可选认证。';
      else normalized = u.href;
    } catch { error = '代理 URL 无效，请包含 http:// 或 https://。'; }
  }
  const warnings = [];
  if (!key && (env.ALL_PROXY || env.all_proxy)) warnings.push('仅检测到 ALL_PROXY：Claude Code 官方代理变量不包含它，本配置按无显式代理处理。');
  if (env.NODE_EXTRA_CA_CERTS || env.CLAUDE_CODE_CLIENT_CERT || env.CLAUDE_CODE_CLIENT_KEY) warnings.push('检测到额外 CA / mTLS 配置；本工具不加载客户端私钥，TLS 行为可能不同。');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') warnings.push('检测到关闭 TLS 校验的配置；本工具仍校验证书。');
  if (env.CLAUDE_CODE_CERT_STORE) warnings.push('本工具使用 Node 内置及系统信任库；不复现自定义 Claude 证书库选择。');
  const provider = ['BEDROCK', 'VERTEX', 'FOUNDRY'].find(p => env[`CLAUDE_CODE_USE_${p}`] === '1') || 'Anthropic';
  if (provider !== 'Anthropic') warnings.push(`检测到 ${provider}；其模型和身份验证路径未覆盖，不将 Anthropic 探测当作该供应商出口。`);
  let apiOrigin = 'https://api.anthropic.com';
  let customApi = false;
  if (env.ANTHROPIC_BASE_URL) {
    customApi = true;
    try {
      const u = new URL(env.ANTHROPIC_BASE_URL);
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error();
      apiOrigin = u.origin;
      warnings.push('使用自定义 API 地址：仅检查其 HTTPS 根路径；不向它发送账号凭据，也不假设它支持源 IP 回显。');
    } catch { error ||= '自定义 API 地址必须是无内嵌凭据的 HTTPS URL。'; }
  }
  const noProxy = env.no_proxy ?? env.NO_PROXY ?? '';
  if (noProxy.includes('/')) warnings.push('NO_PROXY 中的 CIDR 条目未复现；请用具体主机/域名核对路由。');
  return {
    proxy: normalized, noProxy, error, provider, apiOrigin, customApi, source,
    route(url) { if (error) throw new Error('PROFILE_INVALID'); return bypassProxy(url, noProxy) ? '' : normalized; },
    public: { source, proxy: redactProxy(normalized || proxy), proxyKey: key || '无', noProxy,
      provider, apiOrigin, customApi, error, warnings, targetRoutes: Object.fromEntries(Object.entries({ api: apiOrigin, auth: 'https://claude.ai', echo: 'https://api.ipify.org' }).map(([name,url]) => [name,error?'invalid':normalized&&!bypassProxy(url,noProxy)?'proxy':'direct'])), hasCredentials: !!(normalized && new URL(normalized).username) },
  };
}
export async function readNetworkSettings(home, workspace = '', platform = process.platform, env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const entries = [[path.join(dir, 'settings.json'), '用户 settings.json']];
  if (workspace) entries.push([path.join(workspace, '.claude', 'settings.json'), '项目 settings.json'], [path.join(workspace, '.claude', 'settings.local.json'), '项目 settings.local.json']);
  const managed = platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : platform === 'win32' ? path.join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json') : '/etc/claude-code/managed-settings.json';
  entries.push([managed, '本地 managed-settings.json']);
  const result = { env: {}, sources: [], warnings: [] };
  for (const [file, label] of entries) {
    try {
      if ((await stat(file)).size > 1024 * 1024) throw new Error('SIZE');
      const v = JSON.parse(await readFile(file, 'utf8'));
      Object.assign(result.env, pickNetworkEnv(v.env));
      result.sources.push(label);
    } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') result.warnings.push(`${label} 无法读取或解析；此层未复现。`); }
  }
  return result;
}
