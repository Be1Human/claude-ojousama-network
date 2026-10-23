import path from 'node:path';
import { Store } from './core/store.js';
import { collect } from './core/collector.js';
import { seedDemo } from './core/demo.js';

const port = process.parentPort;
let store, config = {}, timer, busy = false, paused = false, suspended = false, generation = 0, hours = 24, lastRun = 0;
const awaiting = new Map(); let seq = 0;
const send = data => port.postMessage(data);
const snapshot = () => ({ ...store.snapshot(hours), status: { busy, paused, suspended, lastRun, interval:config.interval, demo:!!config.demo } });
function emit() { if (store) send({ type:'snapshot',data:snapshot() }); }
function schedule() {
  clearTimeout(timer);
  if (!paused && !suspended && !config.demo) timer = setTimeout(run, config.interval*1000);
}
async function browserProbe() {
  const id = ++seq;
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{awaiting.delete(id);resolve({ok:false,status:0,error:'浏览器探测超时'});},12000);
    awaiting.set(id,{resolve,timer});send({type:'browser-probe',id});
  });
}
async function run() {
  if (!store || busy || suspended) return;
  clearTimeout(timer);busy=true; const g=generation;emit();
  try {
    if (!config.demo) {
      const result = await collect(store,{...config,browserProbe,valid:()=>g===generation && !suspended});
      if (g===generation) { lastRun=result.time;send({type:'sample',changes:result.observations.filter(r=>r.event==='change').map(r=>({label:r.label}))}); }
    } else lastRun=Date.now();
  } catch { store.event('error','本轮采样未完成；请查看配置和网络连接。'); }
  finally { busy=false;emit();schedule(); }
}
port.on('message',async ({data:m})=>{
  if (m.type==='browser-result') {const pending=awaiting.get(m.id);if(pending){clearTimeout(pending.timer);awaiting.delete(m.id);pending.resolve(m.data);}return;}
  try {
    let data;
    if (m.type==='init') {
      config=m.config;paused=!!config.paused;store=new Store(path.join(m.directory,'network.sqlite3'));
      if(config.demo) seedDemo(store);
      else if(m.legacy) {try{store.importLegacy(m.legacy);}catch{store.event('legacy-error','旧版记录导入失败，原文件保留。');}}
      store.event('start',config.demo?'演示模式；不进行真实网络探测':'开始后台观测');emit();send({type:'ready'});if(!paused) run();
    } else if(m.type==='configure') {const next={...config,...m.config};if(JSON.stringify(next)!==JSON.stringify(config)){config=next;generation++;schedule();emit();}}
    else if(m.type==='sample') {await run();data=snapshot();}
    else if(m.type==='pause') {generation++;paused=!!m.value;store.event(paused?'pause':'resume');schedule();emit();if(!paused)run();}
    else if(m.type==='power') {generation++;suspended=m.value==='suspend';store.event(m.value);schedule();emit();if(!suspended&&!paused)run();}
    else if(m.type==='snapshot') {hours=m.hours||24;data=snapshot();}
    else if(m.type==='history') data=store.history(m.query);
    else if(m.type==='export') data=store.export(m.directory);
    else if(m.type==='import') data=store.importLegacy(m.file);
    else if(m.type==='quit') {generation++;clearTimeout(timer);store?.event('quit');store?.close();process.exit(0);}
    if(m.id)send({type:'reply',id:m.id,data});
  }catch{if(m.type==='init'){send({type:'fatal'});process.exit(1);}if(m.id)send({type:'reply',id:m.id,error:'操作未完成；原数据已保留。'});}
});

// Imports and the message handler must be ready before the parent sends init.
send({type:'listening'});
