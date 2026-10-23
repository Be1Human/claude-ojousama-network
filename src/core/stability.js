import { countryCode, countryName, excludedRegion } from './regions.js';

export const STABILITY_VERSION = 1;
export const BREAK_EVENTS = new Set(['start', 'pause', 'suspend', 'quit', 'error', 'target-change']);
export const reasonLabels = Object.freeze({
  start: '监测重新启动，重新确认', first: '首次确认非中国出口', ip_changed: '出口 IP 改变，重新开始', target_changed: '检测目标改变，重新开始',
  returned_non_cn: '恢复为非中国出口，重新开始', probe_recovered: '探测恢复，重新开始',
  geo_confirmed: '归属地已确认，开始计时', resumed: '恢复连续检测，重新开始',
  excluded: '中国或中国香港出口，计时中断', unknown: '归属地未确认，计时中断',
  failed: '出口探测失败，计时中断', unavailable: '无法确认模型服务出口',
  pause: '暂停检测，计时中断', suspend: '电脑休眠，计时中断', quit: '监测退出，计时中断',
  error: '本轮观测未完成，计时中断', 'target-change': '检测目标改变，计时中断',
  gap: '采样中断，重新开始', clock_changed: '时钟倒退，重新确认',
});
export const gapTolerance = interval => Math.max(90000, (Number(interval) || 30) * 2500);
export const emptyStability = () => ({ version: STABILITY_VERSION, lastObservationId: 0, lastEventId: 0,
  mode: 'waiting', ip: '', family: 0, countryCode: '', source: '', since: null, lastSeenAt: null,
  interval: 30, samples: 0, reason: 'first', lastRun: null, recent: [], stopped: { paused: false, suspended: false, closed: false } });
function completedRun(state, reason) {
  return { since: state.since, endedAt: state.lastSeenAt, durationMs: Math.max(0, state.lastSeenAt - state.since),
    ip: state.ip, countryCode: state.countryCode, reason };
}
function finish(state, reason) {
  if (state.since != null) state.lastRun = completedRun(state, reason);
  state.since = null; state.samples = 0;
}
function remember(state, time, reason) {
  state.recent.unshift({ time, reason, ip: state.ip, countryCode: state.countryCode });
  state.recent = state.recent.slice(0, 6);
}
export function interruptStability(state, event) {
  if (!BREAK_EVENTS.has(event.event) || (event.event === 'start' && state.lastSeenAt == null)) return;
  const hadRun = state.since != null;
  finish(state, event.event);
  state.mode = 'interrupted'; state.reason = event.event;
  if (hadRun) remember(state, event.time, event.event);
}
export function observeStability(state, row) {
  if (state.stopped && Object.values(state.stopped).some(Boolean)) { state.lastObservationId = row.id; return; }
  const previousMode = state.mode, previousIP = state.ip, previousFamily = state.family, previousSource = state.source;
  const code = countryCode(row.geo);
  let mode = row.status !== 'ok' || !row.ip ? 'failed' : row.evidence !== 'edge-trace' ? 'unavailable'
    : excludedRegion(row.geo) ? 'excluded' : !code ? 'unknown' : 'tracking';
  const cadence = Number(row.cadence) > 0 ? Number(row.cadence) : 30;
  let reset = state.reason;
  if (mode !== 'tracking') {
    const hadRun = state.since != null;
    finish(state, mode);
    state.mode = mode; state.reason = mode;
    state.ip = row.ip || ''; state.family = row.family || 0; state.countryCode = code; state.source = row.source || '';
    if (hadRun || previousMode !== mode || previousIP !== state.ip) remember(state, row.time, mode);
  } else {
    if (state.since != null) {
      if (row.time < state.lastSeenAt) reset = 'clock_changed';
      else if (row.time - state.lastSeenAt > gapTolerance(Math.max(state.interval, cadence))) reset = 'gap';
      else if (row.ip !== previousIP || row.family !== previousFamily) reset = 'ip_changed';
      else if ((row.source || '') !== previousSource) reset = 'target_changed';
      else reset = '';
      if (reset) finish(state, reset);
    } else reset = previousMode === 'excluded' ? 'returned_non_cn' : previousMode === 'failed' ? 'probe_recovered'
      : previousMode === 'unknown' ? 'geo_confirmed' : previousMode === 'waiting' ? 'first' : 'resumed';
    state.ip = row.ip; state.family = row.family; state.countryCode = code; state.source = row.source || '';
    if (state.since == null) { state.since = row.time; state.reason = reset || 'resumed'; remember(state, row.time, state.reason); }
    state.mode = 'tracking'; state.samples++;
  }
  state.lastSeenAt = row.time; state.interval = cadence; state.lastObservationId = row.id;
}
export function advanceStability(checkpoint, rows, events) {
  const state = structuredClone(checkpoint);
  state.stopped ||= { paused: false, suspended: false, closed: false };
  const apply = event => {
    interruptStability(state,event);
    if(event.event==='start')state.stopped={paused:false,suspended:false,closed:false};
    if(event.event==='pause')state.stopped.paused=true;
    if(event.event==='resume')state.stopped.paused=false;
    if(event.event==='suspend')state.stopped.suspended=true;
    if(event.event==='wake')state.stopped.suspended=false;
    if(event.event==='quit')state.stopped.closed=true;
  };
  let index = 0;
  for (const row of rows) {
    while (index < events.length && events[index].time <= row.time) apply(events[index++]);
    observeStability(state, row);
  }
  while (index < events.length) apply(events[index++]);
  if (events.length) state.lastEventId = events.at(-1).id;
  return state;
}
export function stabilityView(state, now = Date.now(), { paused = false, suspended = false, available = true, verifying = false } = {}) {
  let status = state.mode, reason = state.reason;
  const expiresAt = state.lastSeenAt == null ? null : state.lastSeenAt + gapTolerance(state.interval);
  if (paused) { status = 'paused'; reason = 'pause'; }
  else if (suspended) { status = 'suspended'; reason = 'suspend'; }
  else if (!available) { status = 'unavailable'; reason = 'unavailable'; }
  else if (verifying) status = 'verifying';
  else if (state.mode === 'tracking' && (now < state.lastSeenAt || now > expiresAt)) { status = 'interrupted'; reason = now < state.lastSeenAt ? 'clock_changed' : 'gap'; }
  const currentRun = state.since == null ? null : completedRun(state, reason);
  return { status, reason, reasonLabel: reasonLabels[reason] || reason, since: status === 'tracking' ? state.since : null,
    lastSeenAt: state.lastSeenAt, expiresAt, interval: state.interval, samples: state.samples,
    elapsedMs: status === 'tracking' ? Math.max(0, now - state.since) : 0,
    confirmedMs: currentRun?.durationMs || 0, lastRun: status !== 'tracking' && currentRun ? currentRun : state.lastRun,
    ip: state.ip, family: state.family, countryCode: state.countryCode, countryName: countryName(state.countryCode),
    recent: state.recent, lastObservationId: state.lastObservationId };
}
export function liveStability(view, now = Date.now()) {
  if (view?.status !== 'tracking' || view.since == null) return { status: view?.status || 'waiting', elapsedMs: 0 };
  if (now < view.lastSeenAt || now > view.expiresAt) return { status: 'interrupted', elapsedMs: 0 };
  return { status: 'tracking', elapsedMs: Math.max(0, now - view.since) };
}
export function formatDuration(milliseconds) {
  let seconds = Math.floor(Math.max(0, Number(milliseconds) || 0) / 1000);
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return (days ? `${days}天 ` : '') + [hours, minutes, seconds % 60].map(v => String(v).padStart(2, '0')).join(':');
}
export function stabilityNotification(previous, current) {
  if (current.status === 'tracking' && (previous.status !== 'tracking' || previous.since !== current.since))
    return previous.status === 'tracking' ? '出口已改变，非中国连续稳定时长重新开始。' : '已确认非中国、非香港出口，开始连续稳定计时。';
  if (previous.status === 'tracking' && current.status !== 'tracking') return (reasonLabels[current.reason] || '连续观测已中断') + '。';
  return '';
}
