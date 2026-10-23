const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('watch', Object.freeze({
  snapshot: hours=>ipcRenderer.invoke('snapshot',hours),
  copyCaptureCommand: ()=>ipcRenderer.invoke('copy-capture-command'),
  config: ()=>ipcRenderer.invoke('config'),
  history: query=>ipcRenderer.invoke('history',query),
  sample: ()=>ipcRenderer.invoke('sample'),
  pause: value=>ipcRenderer.invoke('pause',value),
  save: values=>ipcRenderer.invoke('settings',values),
  export: ()=>ipcRenderer.invoke('export'),
  importProfile: ()=>ipcRenderer.invoke('import-profile'),
  chooseWorkspace: ()=>ipcRenderer.invoke('workspace'),
  openData: ()=>ipcRenderer.invoke('open-data'),
  openLink: key=>ipcRenderer.invoke('open-link',key),
  onUpdate: fn=>{const h=(_,data)=>fn(data);ipcRenderer.on('update',h);return()=>ipcRenderer.removeListener('update',h);},
}));
