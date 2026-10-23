const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state=null,config=null,currentPage='overview',hiddenIP=false,nextPage=null,historyRows=[],historySeq=0,settingsDirty=false;
const time=t=>t?new Date(t).toLocaleString('zh-CN',{hour12:false}):'—';
const clock=t=>new Date(t).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
const address=ip=>ip?(hiddenIP?(ip.includes(':')?'••••:••••:••••':'•••.•••.•••.•••'):ip):'未获得有效 IP';
function latest(route){return state?.current.filter(r=>r.route===route&&(!route.endsWith('/echo')||r.family===4)).sort((a,b)=>b.time-a.time||b.id-a.id)[0];}
function geo(g={}){return [g.countryCode||g.country,g.city].filter(Boolean).join(' · ')||'归属地暂不可用';}
function isChina(g){
  if(!g||typeof g!=='object')return false;
  const code=String(g.countryCode||g.country_code||'').trim().toUpperCase();
  if(code)return code==='CN';
  return /^(?:CN|China|People['’]?s Republic of China|中国|中华人民共和国|中国大陆|中国内地)$/i.test(String(g.country||'').trim());
}
function chinaRecord(r){return r?.status==='ok'&&!!r.ip&&isChina(r.geo);}
function staleRecord(r){return !!r&&Date.now()-r.time>Math.max((config?.interval||30)*3500,120000);}
function chinaHistoryBadge(r){return chinaRecord(r)?'<span class="badge bad country-badge" data-country-warning="CN">⚠ 当时为中国出口</span>':'';}
function toast(s){$('toast').textContent=s;$('toast').classList.remove('hidden');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.add('hidden'),5000);}
async function act(fn){try{return await fn();}catch(e){toast(String(e.message).replace(/^Error invoking remote method '[^']+': Error: /,''));return null;}}
function navigate(page){currentPage=page;document.querySelectorAll('.page').forEach(el=>el.classList.toggle('active',el.id===page));document.querySelectorAll('.nav').forEach(el=>el.classList.toggle('active',el.dataset.page===page));if(page==='history')loadHistory();}
document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.page)));
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.go)));
function render(){
  if(config){
    $('demo-badge').classList.toggle('hidden',!config.demo);$('version').textContent='v'+config.version;
    $('error-banner').textContent=config.lastError||'';$('error-banner').classList.toggle('hidden',!config.lastError);
    const p=config.profile||{};$('proxy-chip').textContent=p.error?'⚠ 配置无效':p.proxyKey==='无'?'◇ 无显式代理':'◇ 显式代理';
    $('profile-details').innerHTML=[['来源',p.source],['代理变量',p.proxyKey],['代理地址',p.proxy],['NO_PROXY',p.noProxy||'未设置'],['API 地址',p.apiOrigin],['供应商',p.provider],['所选项目',p.workspace],['配置文件',p.sources?.join(' → ')||'未发现'],['终端快照时间',p.capturedAt?time(p.capturedAt):'尚未采集']].map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    $('warnings').innerHTML=[...(p.error?[p.error]:[]),...(p.warnings||[]),'没有终端快照时，应用启动环境可能与 Claude Code 的终端不同；即使导入，运行中的进程也可能保留旧配置。'].map(t=>`<p>${esc(t)}</p>`).join('');
    if(!settingsDirty){$('interval').value=config.interval;$('ipv6').checked=config.ipv6;$('mode').value=config.mode;$('notifications').checked=config.notifications;$('startup').checked=config.startup;$('startup').disabled=!config.startupAvailable||config.demo;$('startup-note').textContent=config.startupAvailable?'安装包支持登录后后台启动；默认关闭。':'开发/演示运行不修改启动项。';}
  }
  if(!state)return;
  const s=state.status||{};const paused=config?.paused??s.paused;
  const chinaRoutes=state.current.filter(r=>!r.route.startsWith('legacy/')&&chinaRecord(r)&&!staleRecord(r));
  const chinaLabels=[...new Set(chinaRoutes.map(r=>`${r.label}${r.family?`（IPv${r.family}）`:''}`))];
  $('country-alert').textContent=chinaLabels.length?`⚠ 最近检测记录显示中国（CN）出口：${chinaLabels.join('、')}。请检查对应线路的 VPN / 代理设置。归属地为第三方数据库估计。`:'';
  $('country-alert').classList.toggle('hidden',!chinaLabels.length);
  $('runtime').textContent=s.demo?'演示模式':paused?'已暂停':s.suspended?'已休眠':s.busy?'检测中…':'后台观测中';$('runtime').className='badge '+(paused?'wait':'good');
  $('pause').textContent=paused?'▶ 继续':'Ⅱ 暂停';$('sample').disabled=!!s.busy;
  const selectedRoute=$('hero-route').value;
  const targetKey=selectedRoute.split('/')[1],effective=config?.profile?.targetRoutes?.[targetKey];
  $('flow-origin').textContent=selectedRoute.startsWith('browser/')?'▣ 独立浏览器':selectedRoute.startsWith('system/')?'▣ 系统网络':'▣ 终端环境';
  $('proxy-chip').textContent=selectedRoute.startsWith('browser/')?'◇ 系统自动代理':selectedRoute.startsWith('system/')?'◇ OS 路由 / TUN':effective==='invalid'?'⚠ 配置无效':effective==='proxy'?'◇ 显式代理':'◇ 无显式代理 / 已绕过';
  const r=latest(selectedRoute),ok=r?.status==='ok',china=chinaRecord(r);
  $('hero-ip').textContent=r?address(r.ip):'等待首次观测';$('hero-ip').classList.toggle('long',!r?.ip||r.ip.includes(':'));
  $('hero-ip').classList.toggle('china-ip',china);
  $('hero-location').textContent=ok?geo(r.geo):(r?.error||'开始记录后，这里会显示出口信息');
  const stale=staleRecord(r);
  $('hero-status').textContent=china?(stale?'⚠ 中国出口 · 记录已过期':s.demo?'⚠ 中国出口 · 演示数据':'⚠ 中国出口'):s.demo?'演示数据':!r?'等待数据':stale?'记录已过期':ok?'已获得回显':'探测未成功';$('hero-status').className='badge '+(china?'bad':ok&&!stale?'good':'wait');
  $('hero-evidence').textContent=r?.evidence?.includes('edge-trace')?'来源：'+r.source+' 的边缘 trace；仅代表本次无凭据探测，不是登录认证结果。':'第三方 IP 回显只代表该探测请求；按域名分流时可能与 Claude 不同。';
  $('last-seen').textContent='最近观测 '+(r?time(r.time):'—');$('geo-source').textContent='GeoIP：'+(r?.geo?.source||'未取得')+' · 估计位置';
  const stat=state.summaries.find(r=>r.route==='cli');$('rate').innerHTML=stat?.rate==null?'—':esc(stat.rate)+'<em>%</em>';$('p95').innerHTML=stat?.p95==null?'—':esc(Math.round(stat.p95))+'<em>ms</em>';$('changes').innerHTML=esc(state.changes)+'<em>次</em>';$('sample-count').textContent=`已保存 ${state.count.toLocaleString()} 条 IP 记录`;
  renderChart();
  const events=state.recent.filter(r=>r.route==='cli/api').slice(0,4);
  $('timeline').innerHTML=events.length?events.map(r=>`<div class="timeline-item"><i></i><time>${clock(r.time)}</time><div><strong>${r.event==='change'?'出口变化':'开始观测'}</strong><small>${r.previous_ip?esc(address(r.previous_ip))+' → ':''}${esc(address(r.ip))}</small><small>${esc(geo(r.geo))} · ${esc(new Date(r.time).toLocaleDateString())}</small>${chinaHistoryBadge(r)}</div></div>`).join(''):'<div class="empty">还没有 API 出口变化记录。<br>大小姐的小本本，慢慢写。</div>';
  const routes=[['cli/api','01 / 模型接口',(config?.profile?.apiOrigin||'https://api.anthropic.com')+' · CLI 环境','使用 Claude Code 代理变量；同域名边缘回显。'],['cli/auth','02 / 认证域名','claude.ai · CLI 环境','CLI 认证请求的候选路径；不等于外部浏览器。'],['browser/auth','03 / 浏览器登录段','claude.ai · 系统代理近似','独立 Chromium 会话遵循系统代理。外部浏览器扩展和独立代理未覆盖。'],['cli/echo','04 / 第三方回显','IPv4 回显 · CLI 环境','用于对照域名分流。和 Claude 目标出口不一致时应分别查看。'],['system/echo','05 / 系统路由','IPv4 · 含 VPN / TUN','绕过 HTTP 代理不代表绕过系统 VPN 或 TUN。']];
  $('path-cards').innerHTML=routes.map(([route,label,target,note])=>{const r=latest(route),china=chinaRecord(r),stale=staleRecord(r);return`<article class="card${china?' china-path':''}"><small>${esc(label)}</small><h3>${esc(target)}</h3><div class="path-ip${china?' china-ip':''}">${esc(r?address(r.ip):'等待观测')}</div><span class="badge ${china?'bad':r?.status==='ok'&&!stale?'good':'wait'}">${esc(r?.status==='ok'?geo(r.geo):(r?.error||'未采样'))}</span>${china?`<p class="country-note" data-country-warning="CN">⚠ ${stale?'上次为中国出口，记录已过期，请重新检测。':'中国出口，请检查这条线路。'}</p>`:stale?'<p>记录已过期，请重新检测。</p>':''}<p>${esc(note)}</p><p>${r?esc(time(r.time)):'—'}</p></article>`;}).join('');
  const previous=$('history-route').value;$('history-route').innerHTML='<option value="">全部路径</option>'+state.routes.map(r=>`<option value="${esc(r.id)}">${esc(r.label)}</option>`).join('');$('history-route').value=previous;
  $('incident-list').innerHTML=state.incidents.length?state.incidents.map(i=>`<div>${esc(i.route)} · ${esc(time(i.start))} — ${i.state==='recovered'?'观测到恢复 '+esc(time(i.recoveredAt)):i.state==='gap'?'随后出现采样缺口，恢复时间未知':'尚未观测到恢复'}<small>（多目标同时失败）</small></div>`).join(''):'当前时段没有记录到两个稳定性目标同时失败。';
  const eventNames={start:'开始观测',pause:'暂停',resume:'继续',suspend:'系统休眠',wake:'系统唤醒',quit:'应用退出','legacy-import':'旧版数据导入'};
  $('lifecycle').innerHTML=state.events.slice(0,14).map(e=>`<div>${esc(time(e.time))} · ${esc(eventNames[e.event]||e.event)} ${esc(e.detail)}</div>`).join('');
}
function renderChart(){
  const data=state.chart,w=640,h=180,pad=34,right=12,top=10,bottom=25;
  if(!data.length){$('chart').innerHTML='<div class="empty">还没有成功的 HTTPS 采样。<br>后台记录会自动出现在这里。</div>';return;}
  const min=Math.min(...data.map(p=>p.t)),max=Math.max(min+60000,...data.map(p=>p.t));const maxY=Math.max(100,...data.filter(p=>p.ms!=null).map(p=>p.ms))*1.15;
  const x=t=>pad+(t-min)/(max-min)*(w-pad-right),y=v=>top+(1-v/maxY)*(h-top-bottom);
  let svg=`<svg viewBox="0 0 ${w} ${h}" aria-hidden="true">`;
  for(let i=0;i<=3;i++){let v=maxY*i/3,yy=y(v);svg+=`<line x1="${pad}" x2="${w-right}" y1="${yy}" y2="${yy}" stroke="#eee8de"/><text x="${pad-6}" y="${yy+3}" text-anchor="end" font-size="9" fill="#a49b91">${Math.round(v)}</text>`;}
  for(const [name,color] of [['Cloudflare','#ed8a4b'],['GitHub','#74aebf']]){
    let d='',last=null;for(const p of data.filter(p=>p.target===name)){if(p.ms==null){last=null;continue;}const move=last==null||p.t-last>Math.max(state.bucket*2.5,90000);d+=(move?'M':'L')+x(p.t).toFixed(1)+','+y(p.ms).toFixed(1)+' ';last=p.t;}
    svg+=`<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
    for(const p of data.filter(p=>p.target===name&&p.ms!=null&&p.allOk===0))svg+=`<circle cx="${x(p.t)}" cy="${y(p.ms)}" r="3.5" fill="#c85036"/>`;
  }
  for(let i=0;i<=4;i++){const t=min+(max-min)*i/4;svg+=`<text x="${x(t)}" y="${h-5}" text-anchor="middle" font-size="9" fill="#a49b91">${esc(clock(t))}</text>`;}
  $('chart').innerHTML=svg+'</svg>';$('chart').setAttribute('aria-label',`最近 ${state.hours} 小时 CLI HTTPS 响应图，共 ${data.length} 个时间桶。`);
}
async function loadHistory(more=false){
  const seq=++historySeq;const query={hours:Number($('history-range').value),route:$('history-route').value,search:$('search').value,changesOnly:$('changes-only').checked};if(more&&nextPage)query.before=nextPage;
  const data=await act(()=>window.watch.history(query));if(!data||seq!==historySeq)return;
  historyRows=more?[...historyRows,...data.rows]:data.rows;nextPage=data.next;
  $('history-rows').innerHTML=historyRows.length?historyRows.map(r=>`<tr${chinaRecord(r)?' class="china-row"':''}><td>${esc(time(r.time))}<small>IPv${r.family||'自动'}</small></td><td>${esc(r.label)}<small>${esc(r.source)}</small></td><td class="code">${esc(address(r.ip))}${r.previous_ip?`<small>此前 ${esc(address(r.previous_ip))}</small>`:''}${r.error?`<small>${esc(r.error)}</small>`:''}</td><td>${esc(geo(r.geo))}${chinaHistoryBadge(r)}<small>${esc([r.geo?.isp,r.geo?.asn].filter(Boolean).join(' · '))}</small><small>来源 ${esc(r.geo?.source||'—')}</small></td><td><span class="badge ${r.event==='change'?'bad':r.status==='ok'?'good':'wait'}">${esc(({first:'首次记录',change:'IP 变化',stable:'保持稳定',error:'探测失败'})[r.event]||r.event)}</span></td></tr>`).join(''):'<tr><td colspan="5" class="empty">这个范围还没有记录。</td></tr>';
  $('history-count').textContent=`已显示 ${historyRows.length} 条记录`;$('more-history').disabled=!nextPage;
}
$('hero-route').addEventListener('change',render);$('range').addEventListener('change',()=>act(async()=>{state=await window.watch.snapshot(Number($('range').value));render();}));
$('privacy').addEventListener('click',()=>{hiddenIP=!hiddenIP;$('privacy').textContent=hiddenIP?'显示 IP':'隐藏 IP';render();if(currentPage==='history')loadHistory();});
$('sample').addEventListener('click',()=>act(async()=>{await window.watch.sample();toast(config?.demo?'演示刷新完成':'本轮检测完成');}));
$('pause').addEventListener('click',()=>act(async()=>{config=await window.watch.pause(!config?.paused);render();}));
$('chibi').addEventListener('click',()=>{const lines=['哈气中…（角色彩蛋）','写代码的话，交给我吧。','家里的规矩……别问。','才不是我想关门的……'];$('chibi-caption').textContent=lines[(($('chibi').counter||0)+1)%lines.length];$('chibi').counter=($('chibi').counter||0)+1;});
for(const id of ['history-range','history-route','changes-only'])$(id).addEventListener('change',()=>loadHistory());
let searchTimer;$('search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadHistory(),250);});$('refresh-history').addEventListener('click',()=>loadHistory());$('more-history').addEventListener('click',()=>loadHistory(true));
$('export').addEventListener('click',()=>act(async()=>{const files=await window.watch.export();if(files)toast('已导出全部记录：'+files.join('、'));}));
$('copy-capture').addEventListener('click',()=>act(async()=>{await window.watch.copyCaptureCommand();toast('命令已复制。在运行 Claude Code 的同一个终端粘贴执行即可。');}));
$('import-profile').addEventListener('click',()=>act(async()=>{const c=await window.watch.importProfile();if(c){config=c;render();toast('终端网络快照已导入。');}}));
$('choose-workspace').addEventListener('click',()=>act(async()=>{const c=await window.watch.chooseWorkspace();if(c){config=c;render();}}));
$('settings-form').addEventListener('input',()=>{settingsDirty=true;$('saved-status').textContent='未保存';});
$('settings-form').addEventListener('submit',e=>{e.preventDefault();act(async()=>{config=await window.watch.save({interval:Number($('interval').value),ipv6:$('ipv6').checked,notifications:$('notifications').checked,startup:$('startup').checked,mode:$('mode').value,proxy:$('proxy').value});settingsDirty=false;$('proxy').value='';render();$('saved-status').textContent='设置已保存';});});
$('clear-capture').addEventListener('click',()=>act(async()=>{config=await window.watch.save({clearCapture:true});settingsDirty=false;render();toast('已清除终端快照，恢复读取应用启动环境。');}));
$('data-folder').addEventListener('click',()=>act(()=>window.watch.openData()));$('github').addEventListener('click',()=>act(()=>window.watch.openLink('repo')));$('docs').addEventListener('click',()=>act(()=>window.watch.openLink('docs')));
window.watch.onUpdate(data=>{if(data.snapshot)state=data.snapshot;if(data.config)config=data.config;render();});
act(async()=>{config=await window.watch.config();render();try{state=await window.watch.snapshot(24);render();}catch{/* Worker publishes when ready. */}});
