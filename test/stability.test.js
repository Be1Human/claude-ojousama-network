import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { countryCode, excludedRegion, confirmedNonChina } from '../src/core/regions.js';
import { emptyStability, advanceStability, stabilityView, liveStability, formatDuration, stabilityNotification } from '../src/core/stability.js';
import { Store } from '../src/core/store.js';

const point = (id,time,extra={}) => ({ id,time,route:'cli/api',label:'模型服务',family:4,ip:'203.0.113.1',status:'ok',source:'api.anthropic.com',evidence:'edge-trace',geo:{countryCode:'US'},cadence:30,...extra });
const stateOf = (rows,events=[]) => advanceStability(emptyStability(),rows,events);
function fixture(t) { const dir=mkdtempSync(path.join(tmpdir(),'stable-run-'));const file=path.join(dir,'network.sqlite3');const store=new Store(file);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return{store,file}; }

test('region eligibility requires known geography and shares CN/HK rules with the UI',()=>{
  for(const country of ['China','中国','中国大陆'])assert.equal(excludedRegion({country}),'CN');
  for(const country of ['Hong Kong','Hong Kong SAR, China','香港','中国香港'])assert.equal(excludedRegion({country}),'HK');
  assert.equal(countryCode({countryCode:' hk ',country:'China'}),'HK');
  assert.equal(confirmedNonChina({country:'Japan'}),true);
  for(const geo of [{},{country:'not a country'},{countryCode:'ZZ'},{countryCode:'XX'},{countryCode:'CN'},{countryCode:'HK'}])assert.equal(confirmedNonChina(geo),false);
});
test('the first verified non-CN/HK exit starts at zero, then the same IP accumulates',()=>{
  const first=stateOf([point(1,1000)]);assert.equal(stabilityView(first,1000).elapsedMs,0);
  const state=advanceStability(first,[point(2,31000)],[]);const v=stabilityView(state,46000);
  assert.equal(v.status,'tracking');assert.equal(v.since,1000);assert.equal(v.elapsedMs,45000);assert.equal(v.confirmedMs,30000);
});
test('a new eligible IP resets the clock and keeps only the last confirmed segment',()=>{
  const state=stateOf([point(1,0),point(2,30000),point(3,60000,{ip:'203.0.113.2',geo:{countryCode:'JP'}})]);
  const v=stabilityView(state,61000);assert.equal(v.since,60000);assert.equal(v.elapsedMs,1000);assert.equal(v.reason,'ip_changed');assert.equal(v.lastRun.durationMs,30000);
});
test('IPv4 to IPv6 is a real model-exit change even when each family had prior history',()=>{
  const s=stateOf([point(1,0),point(2,30000,{family:6,ip:'2001:db8::1'}),point(3,60000)]);
  assert.equal(s.since,60000);assert.equal(s.reason,'ip_changed');
});
test('unchanged IP with a different eligible GeoIP label does not reset the clock',()=>{
  const s=stateOf([point(1,0),point(2,30000,{geo:{countryCode:'DE'}})]);assert.equal(s.since,0);
});
for(const code of ['CN','HK'])test(`${code} cannot accumulate even when its IP never changes`,()=>{
  const rows=[point(1,0),point(2,30000),point(3,60000,{geo:{countryCode:code}}),point(4,90000,{geo:{countryCode:code}})];
  const s=stateOf(rows),v=stabilityView(s,100000);assert.equal(v.status,'excluded');assert.equal(v.elapsedMs,0);assert.equal(v.lastRun.durationMs,30000);
  const recovered=advanceStability(s,[point(5,120000)],[]);assert.equal(recovered.since,120000);assert.equal(recovered.reason,'returned_non_cn');
});
test('unknown GeoIP breaks a segment and confirmation restarts without retroactive time',()=>{
  const s=stateOf([point(1,0),point(2,30000),point(3,60000,{geo:{}})]);assert.equal(stabilityView(s,65000).status,'unknown');
  const r=advanceStability(s,[point(4,90000)],[]);assert.equal(r.since,90000);assert.equal(r.reason,'geo_confirmed');
});
test('probe failure stops time; returning to the same IP starts a new segment',()=>{
  const s=stateOf([point(1,0),point(2,30000),point(3,60000,{status:'error',ip:'',family:0})]);
  assert.equal(stabilityView(s,65000).status,'failed');assert.equal(s.lastRun.durationMs,30000);
  assert.equal(advanceStability(s,[point(4,90000)],[]).since,90000);
});
test('third-party echo cannot replace a missing model-domain observation',()=>{
  assert.equal(stabilityView(stateOf([point(1,0,{evidence:'echo'})]),0).status,'unavailable');
});
test('unobserved gaps and backwards clocks cannot be added to the duration',()=>{
  const s=stateOf([point(1,0),point(2,30000)]),stale=stabilityView(s,120001);
  assert.equal(stale.status,'interrupted');assert.equal(stale.elapsedMs,0);assert.equal(stale.lastRun.durationMs,30000);
  const next=advanceStability(s,[point(3,150000)],[]);assert.equal(next.since,150000);assert.equal(next.reason,'gap');
  const backwards=advanceStability(s,[point(3,1000)],[]);assert.equal(backwards.since,1000);assert.equal(backwards.reason,'clock_changed');
});
test('pause/old manual samples and sleep do not fabricate monitored time',()=>{
  const rows=[point(1,0),point(2,30000),point(3,60000),point(4,90000)];
  const s=stateOf(rows,[{id:1,time:45000,event:'pause'},{id:2,time:80000,event:'resume'}]);
  assert.equal(s.since,90000);assert.equal(s.lastRun.durationMs,30000);
  const sleeping=stateOf(rows,[{id:1,time:45000,event:'suspend'},{id:2,time:80000,event:'wake'}]);assert.equal(sleeping.since,90000);
});
test('explicit exit and restarting preserve the completed segment, not elapsed offline time',()=>{
  const s=stateOf([point(1,0),point(2,30000),point(3,90000)],[{id:1,time:45000,event:'quit'},{id:2,time:80000,event:'start'}]);
  assert.equal(s.since,90000);assert.equal(s.lastRun.durationMs,30000);
});
test('an abrupt app restart cannot silently add offline time within the normal sample tolerance',()=>{
  const s=stateOf([point(1,0),point(2,30000),point(3,60000)],[{id:1,time:45000,event:'start'}]);
  assert.equal(s.since,60000);assert.equal(s.lastRun.durationMs,30000);
  const waiting=stateOf([],[{id:1,time:0,event:'start'}]);assert.equal(waiting.mode,'waiting');
});
test('freshness uses sampling cadence; the renderer clock also stops at expiry',()=>{
  const s=stateOf([point(1,0,{cadence:300}),point(2,300000,{cadence:300})]);const v=stabilityView(s,600000);
  assert.equal(v.status,'tracking');assert.equal(liveStability(v,1050001).status,'interrupted');assert.equal(liveStability(v,1050001).elapsedMs,0);
  assert.equal(stabilityView(s,600000,{paused:true}).elapsedMs,0);assert.equal(stabilityView(s,600000,{available:false}).status,'unavailable');assert.equal(stabilityView(s,600000,{verifying:true}).elapsedMs,0);
});
test('duration spans midnight and days; notifications describe the main condition',()=>{
  assert.equal(formatDuration(90061000),'1天 01:01:01');assert.equal(formatDuration(-1),'00:00:00');
  const a=stabilityView(stateOf([point(1,0)]),0),b=stabilityView(stateOf([point(1,0),point(2,30000)]),31000);
  assert.equal(stabilityNotification(a,b),'');assert.match(stabilityNotification(a,{status:'excluded',reason:'excluded'}),/计时中断/);
});
test('the core metric uses full history, independently of the selected chart period',t=>{
  const {store}=fixture(t),now=Date.now(),start=now-7200000;store.db.exec('BEGIN');
  for(let i=0;i<=24;i++){const row=point(i+1,start+i*300000);store.check({time:row.time,batch:String(row.time),route:'cli',target:'api',kind:'target',ok:true,http:200,ms:1,interval:300});store.record(row);}
  store.db.exec('COMMIT');const v=store.snapshot(1).stability;assert.equal(v.since,start);assert.ok(v.elapsedMs>=7200000);
});
test('a persisted checkpoint replays newly appended rows after process restart',t=>{
  const {store,file}=fixture(t);store.record(point(1,1000));store.record(point(2,31000));assert.equal(store.stability(31000).since,1000);
  const other=new Store(file);try{other.record(point(3,61000));assert.equal(other.stability(61000).since,1000);}finally{other.close();}
  assert.equal(store.stability(61000).since,1000);
});
test('external replacements/deletions invalidate cached state even if SQLite reuses IDs',t=>{
  const {store,file}=fixture(t);store.record(point(1,1000));assert.equal(store.stability(1000).status,'tracking');
  const other=new Store(file);try{other.db.exec("DELETE FROM observations WHERE route='cli/api'");other.record(point(1,2000,{geo:{countryCode:'HK'}}));}finally{other.close();}
  assert.equal(store.stability(2000).status,'excluded');assert.equal(store.stability(2000).elapsedMs,0);
});
