export function seedDemo(store) {
  if(store.snapshot().count)return;
  store.db.exec('BEGIN');
  try {
  const now=Date.now(), old=now-24*3600000;
  const location={country:'United States',countryCode:'US',region:'California',city:'Los Angeles',asn:'DEMO',isp:'演示网络 · RFC 5737',source:'演示数据',checkedAt:now};
  for(let i=0;i<=144;i++) {
    const time=old+i*600000;
    if(i>=63&&i<=69)continue;
    const ip=i<42?'198.51.100.17':i<98?'203.0.113.27':'203.0.113.42';
    for(const [route,label] of [['cli/api','模型域名 · CLI 路径'],['cli/auth','认证域名 · CLI 路径'],['browser/auth','认证域名 · 系统浏览器近似'],['system/echo','系统路由回显'],['cli/echo','CLI 第三方回显']])store.record({time,route,label,family:4,ip,status:'ok',source:'演示数据',evidence:route.includes('echo')?'echo':'edge-trace',geo:location,ms:140});
    store.check({time,batch:String(time),route:'cli',target:'api',kind:'target',ok:true,http:200,ms:140,error:'',interval:600});
    for(const route of ['cli','system'])for(const [j,target] of ['Cloudflare','GitHub'].entries())store.check({time,batch:String(time),route,target,kind:'stability',ok:!(i===54&&j===1),http:i===54&&j===1?0:200,ms:105+(Math.sin(i*2.8)+1)*38+(i%17===0?100:0)+j*22,error:i===54&&j===1?'请求超时':'',interval:600});
  }
  for(const route of ['cli','browser'])for(const target of ['auth'])store.check({time:now,batch:String(now),route,target,kind:'target',ok:true,http:200,ms:126,error:'',interval:30});
  store.event('suspend','演示：休眠，未采样区间不计为掉线',old+63*600000);
  store.event('wake','演示：恢复观测',old+70*600000);
  store.db.exec('COMMIT');
  } catch(error) { if(store.db.isTransaction)store.db.exec('ROLLBACK');throw error; }
}
