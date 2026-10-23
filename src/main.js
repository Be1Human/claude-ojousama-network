import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, utilityProcess, session, powerMonitor, dialog, shell, safeStorage, Notification, clipboard } from 'electron';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickNetworkEnv, createProfile, readNetworkSettings } from './core/profile.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const demo=process.argv.includes('--demo');
const captureFlag=process.argv.includes('--capture-network-env');
app.setPath('userData',demo?path.join(os.tmpdir(),`ClaudeOjouDemo-${process.pid}`):path.join(app.getPath('appData'),'ClaudeOjouNetwork'));
const directory=app.getPath('userData'),configPath=path.join(directory,'settings.json');
mkdirSync(directory,{recursive:true,mode:0o700});
const defaults={interval:30,ipv6:true,paused:false,mode:'auto',notifications:false,workspace:'',manualProxy:'',capturedEnv:null,capturedAt:'',source:'应用启动环境'};
let settings={...defaults},win,tray,worker,quitting=false,lastSnapshot=null,profileInfo={},workerReady=false,restarts=0,lastError='',startupWarning='',seq=0;
const pending=new Map();
const legacy=process.platform==='darwin'?path.join(os.homedir(),'Library','Application Support','NetworkWatch','ip-history.sqlite3'):'';
if(!app.requestSingleInstanceLock({capture:captureFlag?pickNetworkEnv(process.env):null,capturedAt:new Date().toISOString()})){app.quit();}else{
(async()=>{
app.on('second-instance',async(_event,_args,_cwd,data)=>{if(data?.capture){settings.capturedEnv=pickNetworkEnv(data.capture);settings.capturedAt=data.capturedAt;await persist();worker?.postMessage({type:'configure',config:await resolveProfile()});publish();}show();});
app.on('activate',()=>show());
app.on('window-all-closed',()=>{});
app.on('before-quit',()=>{quitting=true;worker?.postMessage({type:'quit'});});
app.on('will-quit',()=>{worker?.kill();for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('应用退出'));}});
await app.whenReady();
loadSettings();
if(captureFlag){settings.capturedEnv=pickNetworkEnv(process.env);settings.capturedAt=new Date().toISOString();await persist();}
const probeSession=session.fromPartition('network-observer-probes');
probeSession.setPermissionRequestHandler((_w,_p,callback)=>callback(false));
function loadSettings(){
  if(!existsSync(configPath)||demo)return;
  try{const v=JSON.parse(readFileSync(configPath,'utf8'));settings={...defaults,...v};if(v.private){if(!safeStorage.isEncryptionAvailable())throw new Error();Object.assign(settings,JSON.parse(safeStorage.decryptString(Buffer.from(v.private,'base64'))));}delete settings.private;}
  catch{settings={...defaults,paused:true};startupWarning='私有代理配置无法解密，已暂停观测；请重新导入。历史数据保留。';lastError=startupWarning;}
}
function persist(){
  if(demo)return;
  const {manualProxy,capturedEnv,...publicSettings}=settings;
  if(manualProxy||capturedEnv){if(!safeStorage.isEncryptionAvailable())throw new Error('系统加密存储不可用，无法保存代理配置。');publicSettings.private=safeStorage.encryptString(JSON.stringify({manualProxy,capturedEnv})).toString('base64');}
  const temp=configPath+'.tmp';writeFileSync(temp,JSON.stringify(publicSettings,null,2),{mode:0o600});
  // Same-volume replacement keeps config updates atomic.
  renameSync(temp,configPath);
}
async function resolveProfile(){
  const inherited=settings.capturedEnv||pickNetworkEnv(process.env);
  const read=await readNetworkSettings(os.homedir(),settings.workspace,process.platform,{...process.env,...inherited});
  let env={...inherited,...read.env};
  if(settings.mode!=='auto'){
    for(const k of ['https_proxy','HTTPS_PROXY','http_proxy','HTTP_PROXY','all_proxy','ALL_PROXY'])delete env[k];
    if(settings.mode==='manual'&&settings.manualProxy)env.HTTPS_PROXY=settings.manualProxy;
    if(settings.mode==='manual'&&!settings.manualProxy)env.HTTPS_PROXY='invalid';
  }
  const source=demo?'演示数据':settings.capturedEnv?'已导入的终端环境快照 + 配置文件':'应用启动环境 + 配置文件（可能不同于终端）';
  const p=createProfile(env,source);profileInfo={...p.public,sources:read.sources,warnings:[...p.public.warnings,...read.warnings],capturedAt:settings.capturedAt,mode:settings.mode,workspace:settings.workspace?path.basename(settings.workspace):'未选择项目'};
  return{env,source,interval:settings.interval,ipv6:settings.ipv6,paused:settings.paused,demo};
}
function publicConfig(){return{interval:settings.interval,ipv6:settings.ipv6,paused:settings.paused,mode:settings.mode,notifications:settings.notifications,profile:profileInfo,startup:app.isPackaged?app.getLoginItemSettings().openAtLogin:false,startupAvailable:app.isPackaged,demo,version:app.getVersion(),lastError,platform:process.platform};}
function publish(){if(win&&!win.isDestroyed())win.webContents.send('update',{snapshot:lastSnapshot,config:publicConfig()});updateTray();}
function requestWorker(type,payload={}){
  if(!workerReady)return Promise.reject(new Error('后台正在启动，请稍候。'));
  const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('后台响应超时'));},45000);pending.set(id,{resolve,reject,timer});worker.postMessage({type,id,...payload});});
}
async function browserProbe(){
  const start=Date.now(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
    const r=await probeSession.fetch('https://claude.ai/cdn-cgi/trace',{credentials:'omit',cache:'no-store',redirect:'manual',signal:controller.signal,headers:{'Cache-Control':'no-cache'}});
    let body='',bytes=0;const reader=r.body?.getReader();
    if(reader){while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>131072){await reader.cancel();throw new Error();}body+=new TextDecoder().decode(value);}}
    return{ok:true,status:r.status,body,totalMs:Date.now()-start,error:''};
  }catch{return{ok:false,status:0,body:'',totalMs:Date.now()-start,error:'系统浏览器路径连接或 TLS 失败'};}
  finally{clearTimeout(timer);}
}
async function startWorker(){
  if(quitting)return;workerReady=false;
  const config=await resolveProfile();
  const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP','HOME','USERPROFILE','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  const child=utilityProcess.fork(path.join(root,'src','worker.js'),[],{serviceName:'Claude Ojou Network Observer',env,stdio:'pipe'});worker=child;
  child.stderr.on('data',()=>{});child.stdout.on('data',()=>{});
  child.on('spawn',()=>child.postMessage({type:'init',directory,legacy:demo?'':legacy,config}));
  child.on('message',async m=>{
    if(m.type==='ready'){workerReady=true;lastError=startupWarning;publish();}
    else if(m.type==='snapshot'){lastSnapshot=m.data;publish();}
    else if(m.type==='browser-probe'){const data=await browserProbe();if(worker===child)child.postMessage({type:'browser-result',id:m.id,data});}
    else if(m.type==='reply'){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.data);}}
    else if(m.type==='sample'&&m.changes.length&&settings.notifications&&Notification.isSupported()){new Notification({title:'网络手账 · 出口发生变化',body:`${m.changes.length} 条观测路径出现 IP 变化。打开手账查看详细记录。`}).show();}
  });
  child.on('exit',()=>{
    if(worker!==child)return;workerReady=false;
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('后台进程已重启'));}pending.clear();
    if(!quitting){lastError='采样进程已停止，正在尝试恢复。';publish();if(restarts++<3)setTimeout(startWorker,Math.min(1000*2**restarts,15000));else{lastError='后台重试已停止；请点击立即检测重启。';publish();}}
  });
}
function show(){if(!win)return;if(process.platform==='darwin')app.dock?.show();win.show();win.focus();}
function updateTray(){if(!tray)return;tray.setToolTip(`大小姐的网络手账 · ${lastError?'后台异常':settings.paused?'已暂停':lastSnapshot?.status.busy?'检测中':'观测中'}`);tray.setContextMenu(Menu.buildFromTemplate([{label:'打开网络手账',click:show},{label:settings.paused?'继续观测':'暂停观测',click:()=>setPaused(!settings.paused)},{label:'立即检测',click:()=>requestWorker('sample').catch(()=>{})},{type:'separator'},{label:'退出',click:()=>app.quit()}]));}
async function setPaused(value){settings.paused=!!value;await persist();worker?.postMessage({type:'pause',value:settings.paused});publish();}
win=new BrowserWindow({width:1400,height:940,minWidth:1050,minHeight:720,show:false,title:'大小姐的网络手账',backgroundColor:'#fff8ed',autoHideMenuBar:true,icon:path.join(root,'assets','icon.png'),webPreferences:{preload:path.join(root,'src','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,spellcheck:false}});
win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
win.webContents.on('will-navigate',e=>e.preventDefault());
win.webContents.session.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
win.on('close',e=>{if(!quitting){e.preventDefault();win.hide();if(process.platform==='darwin')app.dock?.hide();}});
win.once('ready-to-show',()=>{if(!process.argv.includes('--hidden'))show();});
const icon=nativeImage.createFromPath(path.join(root,'assets',process.platform==='darwin'?'trayTemplate.png':'icon.png')).resize({width:process.platform==='darwin'?20:24,height:process.platform==='darwin'?20:24});
if(process.platform==='darwin')icon.setTemplateImage(true);
tray=new Tray(icon);tray.on('click',show);updateTray();
const page=path.join(root,'src','renderer','index.html');
function handle(name,fn){ipcMain.handle(name,async(e,...args)=>{
  if(e.sender!==win.webContents||!e.senderFrame?.url.startsWith('file:')||fileURLToPath(new URL(e.senderFrame.url).href.split('?')[0])!==page)throw new Error('不允许的调用来源');
  try{return await fn(...args);}catch(error){throw new Error(error.message?.includes('无法')||error.message?.includes('请')?error.message:'操作失败，数据已保留。');}
});}
handle('config',()=>publicConfig());handle('snapshot',h=>requestWorker('snapshot',{hours:h}));handle('history',q=>requestWorker('history',{query:q&&typeof q==='object'?q:{}}));
handle('sample',async()=>{if(!workerReady){restarts=0;startWorker();return null;}return requestWorker('sample');});
handle('pause',async v=>{await setPaused(v);return publicConfig();});
handle('settings',async v=>{
  const next={...settings};if([15,30,60,300].includes(v.interval))next.interval=v.interval;
  if(typeof v.ipv6==='boolean')next.ipv6=v.ipv6;if(typeof v.notifications==='boolean')next.notifications=v.notifications;
  if(['auto','manual','direct'].includes(v.mode))next.mode=v.mode;
  if(typeof v.proxy==='string'&&v.proxy.trim()){const p=createProfile({HTTPS_PROXY:v.proxy.trim()});if(p.error)throw new Error(p.error);next.manualProxy=v.proxy.trim();}
  if(next.mode==='manual'&&!next.manualProxy)throw new Error('请填写 HTTP(S) 代理地址。');
  if(v.clearCapture){next.capturedEnv=null;next.capturedAt='';}
  const previous=settings;settings=next;try{await persist();}catch(e){settings=previous;throw e;}
  if(typeof v.startup==='boolean'&&app.isPackaged&&!demo)app.setLoginItemSettings({openAtLogin:v.startup,args:v.startup?['--hidden']:[]});
  worker?.postMessage({type:'configure',config:await resolveProfile()});publish();return publicConfig();
});
handle('import-profile',async()=>{
  const r=await dialog.showOpenDialog(win,{title:'导入终端网络环境快照',filters:[{name:'Network profile',extensions:['json']}],properties:['openFile']});if(r.canceled)return null;
  const data=readFileSync(r.filePaths[0]);if(data.length>100000)throw new Error('文件过大，请使用项目提供的导出脚本。');
  let v;try{v=JSON.parse(data);}catch{throw new Error('无法解析配置文件。');}
  if(v.version!==1||!v.env||typeof v.env!=='object'||Array.isArray(v.env))throw new Error('请使用网络环境快照文件。');
  const previous=settings;settings={...settings,capturedEnv:pickNetworkEnv(v.env),capturedAt:typeof v.capturedAt==='string'?v.capturedAt.slice(0,40):new Date().toISOString()};
  try{await persist();}catch(e){settings=previous;throw e;}
  worker?.postMessage({type:'configure',config:await resolveProfile()});publish();return publicConfig();
});
handle('workspace',async()=>{const r=await dialog.showOpenDialog(win,{title:'选择运行 Claude Code 的项目目录',properties:['openDirectory']});if(r.canceled)return null;settings.workspace=r.filePaths[0];await persist();worker?.postMessage({type:'configure',config:await resolveProfile()});publish();return publicConfig();});
handle('export',async()=>{const r=await dialog.showOpenDialog(win,{title:'导出全部 IP 与 HTTPS 历史',properties:['openDirectory','createDirectory']});if(r.canceled)return null;const files=await requestWorker('export',{directory:r.filePaths[0]});shell.showItemInFolder(files[0]);return files.map(f=>path.basename(f));});
handle('open-data',()=>shell.openPath(directory));
handle('copy-capture-command',()=>{const exe=process.execPath;const quote=s=>"'"+s.replaceAll("'",process.platform==='win32'?"''":"'\"'\"'")+"'";const command=(process.platform==='win32'?'& ':'')+quote(exe)+(app.isPackaged?'':' '+quote(root))+' --capture-network-env';clipboard.writeText(command);return true;});
handle('open-link',key=>{const links={repo:'https://github.com/Be1Human/claude-ojousama-network',docs:'https://code.claude.com/docs/en/network-config'};if(links[key])return shell.openExternal(links[key]);});
powerMonitor.on('suspend',()=>worker?.postMessage({type:'power',value:'suspend'}));powerMonitor.on('resume',()=>worker?.postMessage({type:'power',value:'wake'}));
await win.loadFile(page);await startWorker();
setInterval(async()=>{if(workerReady&&!quitting){worker.postMessage({type:'configure',config:await resolveProfile()});}},60000).unref();
})().catch(error=>{console.error('Startup failed:',error.message);app.quit();});
}
