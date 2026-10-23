import path from 'node:path';
import { Store } from './core/store.js';
import { collect } from './core/collector.js';
import { seedDemo } from './core/demo.js';
import { createProfile } from './core/profile.js';
import { stabilityNotification } from './core/stability.js';

const port = process.parentPort;
let store, config = {}, timer, busy = false, paused = false, suspended = false, generation = 0, verifiedGeneration = -1, verifyNext = false, hours = 24, lastRun = 0;
const awaiting = new Map(); let seq = 0;
const send = data => port.postMessage(data);
function runtime() {
  const profile = createProfile(config.env || {});
  return { paused, suspended, available: profile.provider === 'Anthropic' && !profile.customApi && !profile.error,
    verifying: !config.demo && verifiedGeneration !== generation };
}
const snapshot = () => ({ ...store.snapshot(hours,runtime()), status: { busy, paused, suspended, lastRun, interval:config.interval, demo:!!config.demo } });
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
  if (!store || busy || suspended || paused) return;
  clearTimeout(timer);busy=true; const g=generation, previous=store.stability(Date.now(),runtime());emit();
  try {
    if (!config.demo) {
      const result = await collect(store,{...config,browserProbe,valid:()=>g===generation && !suspended});
      if (g===generation) { verifiedGeneration=g;lastRun=result.time;send({type:'sample',transition:stabilityNotification(previous,store.stability(Date.now(),runtime()))}); }
    } else lastRun=Date.now();
  } catch { store.event('error','本轮采样未完成；请查看配置和网络连接。');if(g===generation)verifiedGeneration=g; }
  finally { busy=false;emit();if(verifyNext&&!paused&&!suspended){verifyNext=false;timer=setTimeout(run,0);}else schedule(); }
}
port.on('message',async ({data:m})=>{
  if (m.type==='browser-result') {const pending=awaiting.get(m.id);if(pending){clearTimeout(pending.timer);awaiting.delete(m.id);pending.resolve(m.data);}return;}
  try {
    let data;
    if (m.type==='init') {
      config=m.config;paused=!!config.paused;store=new Store(path.join(m.directory,'network.sqlite3'));
      if(config.demo){store.event('start','演示模式；不进行真实网络探测',Date.now()-24*3600000-1000);seedDemo(store);}
      else if(m.legacy) {try{store.importLegacy(m.legacy);}catch{store.event('legacy-error','旧版记录导入失败，原文件保留。');}}
      if(!config.demo)store.event('start','开始后台观测');
      if(paused)store.event('pause','启动时保持暂停');
      if(m.observerRestart)store.event('error','后台进程重启，连续稳定计时中断');
      emit();send({type:'ready'});if(!paused) run();
    } else if(m.type==='configure') {
      const next={...config,...m.config};
      if(JSON.stringify(next)!==JSON.stringify(config)){
        const changed=JSON.stringify(next.env)!==JSON.stringify(config.env),previousGeneration=generation;
        const oldTarget=createProfile(config.env||{}),newTarget=createProfile(next.env||{});
        if(oldTarget.provider!==newTarget.provider||oldTarget.apiOrigin!==newTarget.apiOrigin||oldTarget.customApi!==newTarget.customApi)store.event('target-change','模型服务检测目标已改变');
        config=next;generation++;
        if(!changed&&verifiedGeneration===previousGeneration)verifiedGeneration=generation;
        if(changed){verifyNext=true;if(!busy&&!paused&&!suspended){verifyNext=false;run();}else emit();}
        else{schedule();emit();}
      }
    }
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
