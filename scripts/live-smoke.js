import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/core/store.js';
import { collect } from '../src/core/collector.js';
import { pickNetworkEnv } from '../src/core/profile.js';
const directory=mkdtempSync(path.join(os.tmpdir(),'ojou-live-')),store=new Store(path.join(directory,'live.db'));
try{const r=await collect(store,{env:pickNetworkEnv(process.env),ipv6:true});console.log(JSON.stringify({testedAt:new Date().toISOString(),observations:r.observations.map(o=>({route:o.route,family:o.family,status:o.status,evidence:o.evidence,geoSource:o.geo?.source||'',error:o.error})),checks:r.checks.map(c=>({route:c.route,target:c.target,http:c.http,ok:c.ok,error:c.error})),integrity:store.db.prepare('PRAGMA integrity_check').get()},null,2));if(!r.observations.some(o=>o.status==='ok'))process.exitCode=1;}finally{store.close();rmSync(directory,{recursive:true,force:true});}
