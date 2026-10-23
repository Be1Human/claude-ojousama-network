import { createProfile } from './profile.js';
import { request, echo, parseTrace, geoLookup } from './network.js';

export async function collect(store, { env = {}, source = '', interval = 30, ipv6 = true, browserProbe, valid = () => true, fetcher = request } = {}) {
  const profile = createProfile(env,source), time = Date.now(), batch = String(time);
  const results = [], checks = [];
  const geoPending = new Map();
  const geo = async ip => {
    const cached = store.cachedGeo(ip); if (cached) return cached;
    if (!geoPending.has(ip)) geoPending.set(ip, geoLookup(ip,url=>profile.error?'':profile.route(url),fetcher).then(data=>{store.cacheGeo(ip,data);return data;}));
    return geoPending.get(ip);
  };
  const save = async row => { if (row.status === 'ok') row.geo = await geo(row.ip); if (!valid()) return; const r = store.record({ time, ...row }); results.push(r); };
  const check = (route,target,kind,r) => {
    if (!valid()) return;
    const entry = { time,batch,route,target,kind,ok:r.ok && r.status>=200 && r.status<400,http:r.status || 0,ms:r.totalMs,error:r.error || (r.status>=400?`HTTP ${r.status}`:''),interval };
    store.check(entry);checks.push(entry);
  };
  const tasks = [];
  for (const route of ['system','cli']) {
    const proxyFor = route === 'cli' ? url=>profile.route(url) : ()=>'';
    for (const family of (ipv6 ? [4,6] : [4])) tasks.push((async()=>{
      const r = await echo(family,proxyFor,fetcher);
      await save({ ...r,route:`${route}/echo`,label:route==='cli'?'CLI 第三方回显':'系统路由回显', evidence:'echo' });
    })());
    for (const [target,url] of [['Cloudflare','https://www.cloudflare.com/cdn-cgi/trace'],['GitHub','https://github.com/robots.txt']]) tasks.push((async()=>{
      let r; try { r=await fetcher(url,{proxy:proxyFor(url)}); } catch { r={ok:false,status:0,error:'CLI 代理配置无效'}; }
      check(route,target,'stability',r);
    })());
  }
  const hosts = [['auth','认证域名 · CLI 路径','https://claude.ai']];
  if (profile.provider === 'Anthropic') hosts.push(['api','模型域名 · CLI 路径',profile.apiOrigin]);
  for (const [key,label,origin] of hosts) tasks.push((async()=>{
    const custom = key === 'api' && profile.customApi;
    const url = origin + (custom ? '/' : '/cdn-cgi/trace');
    let r; try { r=await fetcher(url,{proxy:profile.route(url)}); } catch { r={ok:false,status:0,error:'CLI 代理配置无效'}; }
    check('cli',key,'target',r);
    const trace = !custom && r.ok && r.status===200 ? parseTrace(r.body,new URL(origin).hostname) : null;
    if (trace) await save({ ...trace,route:`cli/${key}`,label,status:'ok',source:new URL(origin).hostname,evidence:'edge-trace',ms:r.totalMs });
    else await save({ route:`cli/${key}`,label,status:'error',family:0,ip:'',source:new URL(origin).hostname,evidence:custom?'custom-target':'edge-trace',error:custom?'自定义服务无公开源 IP 回显':r.error || `HTTP ${r.status}；未获得有效源 IP`,ms:r.totalMs });
  })());
  if (browserProbe) tasks.push((async()=>{
    let r; try { r=await browserProbe(); } catch { r={ok:false,status:0,error:'系统浏览器路径探测不可用'}; }
    check('browser','auth','target',r);
    const trace = r.ok && r.status===200 ? parseTrace(r.body,'claude.ai') : null;
    if (trace) await save({ ...trace,route:'browser/auth',label:'认证域名 · 系统浏览器近似',status:'ok',source:'claude.ai',evidence:'browser-edge-trace',ms:r.totalMs });
    else await save({ route:'browser/auth',label:'认证域名 · 系统浏览器近似',status:'error',family:0,ip:'',source:'claude.ai',evidence:'browser-edge-trace',error:r.error || `HTTP ${r.status}；未获得源 IP`,ms:r.totalMs });
  })());
  await Promise.all(tasks);
  return { time, observations:results,checks, profile:profile.public };
}
