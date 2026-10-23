import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, chmodSync, openSync, writeSync, closeSync } from 'node:fs';
import path from 'node:path';
import { emptyStability, advanceStability, stabilityView, STABILITY_VERSION } from './stability.js';

export function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * ratio)-1)] * 10) / 10;
}
export function incidents(rows) {
  const batches = new Map();
  for (const r of rows) { const key = `${r.route}:${r.batch}`; if (!batches.has(key)) batches.set(key, []); batches.get(key).push(r); }
  const output = [], active = new Map(), last = new Map();
  for (const group of [...batches.values()].sort((a,b) => a[0].time-b[0].time)) {
    const { route, time, interval } = group[0];
    if (last.has(route) && time-last.get(route) > Math.max(interval*2500, 75000) && active.has(route)) {
      output.push({ ...active.get(route), state: 'gap', recoveredAt: null }); active.delete(route);
    }
    const failed = group.length >= 2 && group.every(r => !r.ok);
    if (failed) {
      if (!active.has(route)) active.set(route, { route, start: time, lastFailure: time, state: 'open', recoveredAt: null });
      active.get(route).lastFailure = time;
    } else if (active.has(route)) {
      output.push({ ...active.get(route), state: 'recovered', recoveredAt: time }); active.delete(route);
    }
    last.set(route, time);
  }
  return [...output, ...active.values()].sort((a,b) => b.start-a.start);
}
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[\s]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
const obs = row => ({ ...row, geo: JSON.parse(row.geo || '{}') });
export class Store {
  constructor(file) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    try { chmodSync(file, 0o600); } catch { /* Windows uses profile ACLs. */ }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY, time INTEGER NOT NULL, route TEXT NOT NULL, label TEXT NOT NULL, family INTEGER, ip TEXT, status TEXT, event TEXT, previous_ip TEXT, source TEXT, evidence TEXT, geo TEXT, ms REAL, error TEXT, legacy_key TEXT UNIQUE);
      CREATE INDEX IF NOT EXISTS observations_series ON observations(route,family,id);
      CREATE INDEX IF NOT EXISTS observations_route_id ON observations(route,id);
      CREATE INDEX IF NOT EXISTS observations_time ON observations(time);
      CREATE TABLE IF NOT EXISTS checks(id INTEGER PRIMARY KEY,time INTEGER, batch TEXT, route TEXT, target TEXT, kind TEXT, ok INTEGER, http INTEGER, ms REAL, error TEXT, interval INTEGER, legacy_key TEXT UNIQUE);
      CREATE INDEX IF NOT EXISTS checks_time ON checks(time,route);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,time INTEGER,event TEXT,detail TEXT);
      CREATE TABLE IF NOT EXISTS geo(ip TEXT PRIMARY KEY,expires INTEGER,payload TEXT);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);`);
  }
  close() { this.db.close(); }
  event(event, detail = '', time = Date.now()) { this.db.prepare('INSERT INTO events(time,event,detail) VALUES(?,?,?)').run(time, event, detail); this.stabilityDirty = true; }
  record(row) {
    const singleTarget = ['cli/api','cli/auth','browser/auth'].includes(row.route);
    const previous = singleTarget
      ? this.db.prepare("SELECT ip,time FROM observations WHERE route=? AND status='ok' ORDER BY id DESC LIMIT 1").get(row.route)
      : this.db.prepare("SELECT ip,time FROM observations WHERE route=? AND family=? AND status='ok' ORDER BY id DESC LIMIT 1").get(row.route, row.family);
    const event = row.status === 'ok' ? (!previous ? 'first' : previous.ip === row.ip ? 'stable' : 'change') : 'error';
    const v = { time: Date.now(), geo: {}, error: '', ms: null, evidence: 'echo', ...row, event, previous_ip: event === 'change' ? previous.ip : '' };
    this.db.prepare('INSERT INTO observations(time,route,label,family,ip,status,event,previous_ip,source,evidence,geo,ms,error,legacy_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(v.time,v.route,v.label,v.family,v.ip || '',v.status,v.event,v.previous_ip,v.source || '',v.evidence,JSON.stringify(v.geo),v.ms ?? v.totalMs ?? null,v.error || '',v.legacy_key || null);
    if (row.route === 'cli/api') this.stabilityDirty = true;
    return v;
  }
  check(row) {
    this.db.prepare('INSERT INTO checks(time,batch,route,target,kind,ok,http,ms,error,interval,legacy_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(row.time,row.batch,row.route,row.target,row.kind,Number(row.ok),row.http || 0,row.ms ?? null,row.error || '',row.interval,row.legacy_key || null);
  }
  cachedGeo(ip) { const r = this.db.prepare('SELECT payload FROM geo WHERE ip=? AND expires>?').get(ip, Date.now()); return r ? JSON.parse(r.payload) : null; }
  cacheGeo(ip, data) { this.db.prepare('INSERT OR REPLACE INTO geo VALUES(?,?,?)').run(ip,Date.now()+(data.country ? 86400000 : 300000),JSON.stringify(data)); }
  history({ hours = 24, route = '', changesOnly = false, search = '', before = Number.MAX_SAFE_INTEGER } = {}) {
    hours = Math.max(1, Math.min(24*3650, Number(hours) || 24));
    const clauses = ['time >= ?', 'id < ?'], args = [Date.now()-hours*3600000, Number(before) || Number.MAX_SAFE_INTEGER];
    if (route) { clauses.push('route=?'); args.push(route); }
    if (changesOnly) clauses.push("event IN ('first','change')");
    if (search) { clauses.push('(ip LIKE ? OR geo LIKE ?)'); args.push(`%${search.slice(0,120)}%`,`%${search.slice(0,120)}%`); }
    const rows = this.db.prepare(`SELECT * FROM observations WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT 201`).all(...args);
    return { rows: rows.slice(0,200).map(obs), next: rows.length > 200 ? rows[199].id : null };
  }
  stability(now = Date.now(), runtime = {}) {
    const dataVersion = this.db.prepare('PRAGMA data_version').get().data_version;
    const externalChange = this.stabilityDataVersion != null && this.stabilityDataVersion !== dataVersion;
    if (!this.stabilityCheckpoint || this.stabilityDirty || externalChange) {
      let checkpoint = externalChange ? emptyStability() : this.stabilityCheckpoint;
      if (!checkpoint) {
        try {
          const cached = JSON.parse(this.db.prepare("SELECT value FROM meta WHERE key='non-cn-stability-v1'").get()?.value || 'null');
          if (cached?.version === STABILITY_VERSION && Number.isInteger(cached.lastObservationId) && Number.isInteger(cached.lastEventId) && Array.isArray(cached.recent)) checkpoint = cached;
        } catch { /* Rebuild the derived checkpoint from original records. */ }
      }
      checkpoint ||= emptyStability();
      const latest = this.db.prepare("SELECT id FROM observations WHERE route='cli/api' ORDER BY id DESC LIMIT 1").get()?.id || 0;
      const latestEvent = this.db.prepare('SELECT MAX(id) id FROM events').get().id || 0;
      if (checkpoint.lastObservationId > latest || checkpoint.lastEventId > latestEvent) checkpoint = emptyStability();
      const rows = this.db.prepare(`SELECT o.*,COALESCE((SELECT c.interval FROM checks c WHERE c.time=o.time
        AND c.route='cli' AND c.kind='target' AND c.target='api' ORDER BY c.id DESC LIMIT 1),30) cadence
        FROM observations o WHERE o.route='cli/api' AND o.id>? ORDER BY o.id`).all(checkpoint.lastObservationId).map(obs);
      const events = this.db.prepare('SELECT id,time,event FROM events WHERE id>? ORDER BY id').all(checkpoint.lastEventId);
      this.stabilityCheckpoint = advanceStability(checkpoint, rows, events);
      this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('non-cn-stability-v1',?)").run(JSON.stringify(this.stabilityCheckpoint));
      this.stabilityDirty = false; this.stabilityDataVersion = dataVersion;
    }
    return stabilityView(this.stabilityCheckpoint, now, runtime);
  }
  snapshot(hours = 24, runtime = {}) {
    hours = [1,6,24,168,720].includes(Number(hours)) ? Number(hours) : 24;
    const since = Date.now()-hours*3600000;
    const current = this.db.prepare('SELECT o.* FROM observations o JOIN (SELECT route,family,MAX(id) id FROM observations GROUP BY route,family) t ON o.id=t.id ORDER BY route,family').all().map(obs);
    const sums = this.db.prepare("SELECT route,COUNT(*) total,SUM(ok) success FROM checks WHERE time>=? AND kind='stability' GROUP BY route").all(since);
    const summaries = sums.map(r => {
      const latencies = this.db.prepare("SELECT ms FROM checks WHERE time>=? AND route=? AND kind='stability' AND ok=1 AND ms IS NOT NULL").all(since,r.route).map(v=>v.ms);
      return { ...r, rate: r.total ? Math.round(10000*r.success/r.total)/100 : null, p50: percentile(latencies,.5), p95: percentile(latencies,.95) };
    });
    const count = this.db.prepare('SELECT COUNT(*) count FROM observations').get().count;
    const changes = this.db.prepare("SELECT COUNT(*) count FROM observations WHERE time>=? AND event='change' AND route='cli/api'").get(since).count;
    const first = this.db.prepare("SELECT MIN(time) time FROM checks WHERE time>=? AND kind='stability' AND route='cli'").get(since).time;
    const bucket = Math.max(30000, Math.ceil(Math.min(hours*3600000,Date.now()-(first || Date.now()))/160));
    const chart = this.db.prepare("SELECT CAST(time/? AS INTEGER)*? t,target,AVG(CASE WHEN ok=1 THEN ms ELSE NULL END) ms,MIN(ok) allOk,COUNT(*) n FROM checks WHERE time>=? AND route='cli' AND kind='stability' GROUP BY t,target ORDER BY t").all(bucket,bucket,since);
    const recent = this.db.prepare("SELECT * FROM observations WHERE time>=? AND event IN ('first','change') ORDER BY id DESC LIMIT 40").all(since).map(obs);
    const targets = this.db.prepare("SELECT c.* FROM checks c JOIN (SELECT route,target,MAX(id) id FROM checks WHERE kind='target' GROUP BY route,target) t ON c.id=t.id").all();
    const analysisRows = this.db.prepare("SELECT time,batch,route,ok,interval FROM checks WHERE time>=? AND kind='stability' ORDER BY time").all(since);
    const events = this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all();
    const allChanges = this.db.prepare("SELECT route,COUNT(*) count FROM observations WHERE time>=? AND event='change' GROUP BY route").all(since);
    const now = Date.now();
    return { now, hours, stability: this.stability(now,runtime), current, summaries, count, changes, allChanges, chart, bucket, recent, targets, incidents: incidents(analysisRows).slice(0,100), events, routes: [...new Map(current.map(r=>[r.route,{id:r.route,label:r.label}])).values()] };
  }
  export(directory) {
    const stamp = new Date().toISOString().replaceAll(':','-').slice(0,19);
    const files = [];
    for (const kind of ['observations','checks']) {
      const file = path.join(directory, `network-${kind}-${stamp}.csv`), fd = openSync(file, 'wx', 0o600);
      try {
        const headers = kind === 'observations' ? ['time_utc','route','family','ip','event','previous_ip','country','region','city','asn','isp','geo_source','geo_checked_utc','probe_source','evidence','status','error'] : ['time_utc','route','target','kind','http','ok','total_ms','error'];
        writeSync(fd, '\ufeff'+headers.map(csvCell).join(',')+'\r\n');
        for (const r of this.db.prepare(`SELECT * FROM ${kind} ORDER BY id`).iterate()) {
          const g = kind === 'observations' ? JSON.parse(r.geo || '{}') : {};
          const values = kind === 'observations' ? [new Date(r.time).toISOString(),r.route,r.family,r.ip,r.event,r.previous_ip,g.country,g.region,g.city,g.asn,g.isp,g.source,g.checkedAt?new Date(g.checkedAt).toISOString():'',r.source,r.evidence,r.status,r.error] : [new Date(r.time).toISOString(),r.route,r.target,r.kind,r.http,r.ok,r.ms,r.error];
          writeSync(fd, values.map(csvCell).join(',')+'\r\n');
        }
        files.push(file);
      } finally { closeSync(fd); }
    }
    return files;
  }
  importLegacy(file) {
    if (!existsSync(file)) return { observations: 0, checks: 0 };
    const old = new DatabaseSync(file, { readOnly: true }); const counts = { observations: 0, checks: 0 };
    try {
      const exists = old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='samples'").get(); if (!exists) return counts;
      this.db.exec('BEGIN');
      for (const r of old.prepare('SELECT id,payload FROM samples ORDER BY id').iterate()) {
        if (this.db.prepare('SELECT id FROM observations WHERE legacy_key=?').get(`v1:${r.id}`)) continue;
        let p; try { p = JSON.parse(r.payload); } catch { continue; }
        const time = Date.parse(p.time_utc); if (!Number.isFinite(time)) continue;
        const result = this.db.prepare('INSERT OR IGNORE INTO observations(time,route,label,family,ip,status,event,previous_ip,source,evidence,geo,ms,error,legacy_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(time,`legacy/${p.route}`,`旧版 · ${p.route_label || p.route}`,p.family || 4,p.ip || '',p.status || 'error',({'IP变化':'change','首次记录':'first'}[p.event]) || (p.status === 'ok' ? 'stable' : 'error'),p.previous_ip || '',p.source || '', 'legacy',JSON.stringify({ country:p.country,region:p.region,city:p.city,asn:p.asn,isp:p.isp,source:p.geo_source,checkedAt:Date.parse(p.geo_checked)||null }),null,p.error || '',`v1:${r.id}`);
        counts.observations += Number(result.changes);
      }
      if (old.prepare("SELECT name FROM sqlite_master WHERE name='probes'").get()) {
        for (const r of old.prepare('SELECT * FROM probes ORDER BY id').iterate()) {
          const result = this.db.prepare('INSERT OR IGNORE INTO checks(time,batch,route,target,kind,ok,http,ms,error,interval,legacy_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(Math.round(r.time*1000),r.batch,`legacy/${r.route}`,r.target,'stability',r.ok,r.http_code,r.total_ms,r.error,r.interval,`v1:${r.id}`);
          counts.checks += Number(result.changes);
        }
      }
      this.db.exec('COMMIT');
    } catch (e) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
    finally { old.close(); }
    if (counts.observations || counts.checks) this.event('legacy-import',`导入 ${counts.observations} 条旧版 IP 记录、${counts.checks} 条 HTTPS 记录；原文件保留。`);
    return counts;
  }
}
