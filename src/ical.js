import ICAL from 'ical.js';

const PROXY_BASE = 'https://todoist-proxy.michael-ewens.workers.dev';
const CACHE_PREFIX = 'dps_ics_cache_';
const THROTTLE_MS = 15 * 60 * 1000;
const WINDOW_DAYS = 5;

const throttleMap = new Map(); // url -> { lastFetchAt, inFlight }

export function normalizeIcsUrl(raw) {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (trimmed.startsWith('webcal://')) return 'https://' + trimmed.slice('webcal://'.length);
  if (trimmed.startsWith('webcals://')) return 'https://' + trimmed.slice('webcals://'.length);
  return trimmed;
}

function cacheKey(url) {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) | 0;
  return CACHE_PREFIX + (h >>> 0).toString(36);
}

function loadCache(url) {
  try {
    const raw = localStorage.getItem(cacheKey(url));
    if (!raw) return null;
    const { events, at } = JSON.parse(raw);
    return { events: events || [], at: at || 0 };
  } catch {
    return null;
  }
}

function saveCache(url, events) {
  try {
    localStorage.setItem(cacheKey(url), JSON.stringify({ events, at: Date.now() }));
  } catch (e) { void e; /* localStorage full or unavailable */ }
}

export function getCachedEventsMulti(entries) {
  const all = [];
  for (const entry of entries) {
    const url = normalizeIcsUrl(entry.url);
    if (!url) continue;
    const c = loadCache(url);
    if (!c) continue;
    for (const ev of c.events) all.push({ ...ev, source: entry.label || '' });
  }
  all.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return all;
}

async function fetchOne(url, { force } = {}) {
  const state = throttleMap.get(url) || { lastFetchAt: 0, inFlight: null };
  const now = Date.now();
  const stale = now - state.lastFetchAt > THROTTLE_MS;
  if (!force && !stale && state.inFlight) return state.inFlight;
  if (!force && !stale) {
    const cached = loadCache(url);
    if (cached?.events?.length) return cached.events;
  }

  state.inFlight = (async () => {
    const res = await fetch(`${PROXY_BASE}/api/ical`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ICS proxy ${res.status}: ${text}`);
    }
    const icsText = await res.text();
    const events = parseEvents(icsText);
    state.lastFetchAt = Date.now();
    saveCache(url, events);
    return events;
  })();
  throttleMap.set(url, state);

  try {
    return await state.inFlight;
  } finally {
    state.inFlight = null;
  }
}

export async function fetchAllEvents(entries, opts = {}) {
  if (!entries || entries.length === 0) return [];
  const results = await Promise.allSettled(
    entries.map(async (entry) => {
      const url = normalizeIcsUrl(entry.url);
      if (!url) return [];
      const events = await fetchOne(url, opts);
      return events.map(ev => ({ ...ev, source: entry.label || '' }));
    })
  );
  const errors = [];
  const merged = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') merged.push(...r.value);
    else errors.push(`${entries[i].label || entries[i].url}: ${r.reason.message}`);
  });
  merged.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  if (merged.length === 0 && errors.length > 0) throw new Error(errors.join('; '));
  return merged;
}

function toIso(t) {
  if (!t) return null;
  if (t.isDate) {
    const yyyy = String(t.year).padStart(4, '0');
    const mm = String(t.month).padStart(2, '0');
    const dd = String(t.day).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return t.toJSDate().toISOString();
}

function parseEvents(icsText) {
  const jcal = ICAL.parse(icsText);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents('vevent');

  const now = ICAL.Time.now();
  const windowStart = now.clone();
  const windowEnd = now.clone();
  windowEnd.addDuration(ICAL.Duration.fromData({ days: WINDOW_DAYS }));

  const overrides = new Map();
  const simpleAndMasters = [];
  for (const v of vevents) {
    const e = new ICAL.Event(v);
    if (e.isRecurrenceException()) {
      const recId = v.getFirstPropertyValue('recurrence-id');
      overrides.set(`${e.uid}|${recId.toString()}`, v);
    } else {
      simpleAndMasters.push(v);
    }
  }

  const out = [];
  for (const v of simpleAndMasters) {
    const event = new ICAL.Event(v);
    if ((v.getFirstPropertyValue('status') || '').toString().toUpperCase() === 'CANCELLED') continue;

    if (event.isRecurring()) {
      const iter = event.iterator();
      let next;
      let safety = 0;
      while ((next = iter.next()) && safety++ < 500) {
        if (next.compare(windowEnd) >= 0) break;
        if (next.compare(windowStart) < 0) continue;
        const key = `${event.uid}|${next.toString()}`;
        if (overrides.has(key)) {
          const ovVevent = overrides.get(key);
          if ((ovVevent.getFirstPropertyValue('status') || '').toString().toUpperCase() === 'CANCELLED') continue;
          const ov = new ICAL.Event(ovVevent);
          out.push({
            uid: event.uid,
            recurrenceId: next.toString(),
            title: ov.summary || event.summary || '',
            start: toIso(ov.startDate),
            end: toIso(ov.endDate),
            allDay: !!ov.startDate?.isDate,
            instanceId: `uid:${event.uid}|rid:${next.toString()}`,
          });
        } else {
          const endTime = event.duration ? (() => { const t = next.clone(); t.addDuration(event.duration); return t; })() : null;
          out.push({
            uid: event.uid,
            recurrenceId: next.toString(),
            title: event.summary || '',
            start: toIso(next),
            end: endTime ? toIso(endTime) : null,
            allDay: !!event.startDate?.isDate,
            instanceId: `uid:${event.uid}|rid:${next.toString()}`,
          });
        }
      }
    } else {
      const start = event.startDate;
      if (!start) continue;
      if (start.compare(windowEnd) >= 0) continue;
      const endForFilter = event.endDate || start;
      if (endForFilter.compare(windowStart) < 0) continue;
      out.push({
        uid: event.uid,
        recurrenceId: null,
        title: event.summary || '',
        start: toIso(start),
        end: toIso(event.endDate),
        allDay: !!start.isDate,
        instanceId: `uid:${event.uid}|start:${toIso(start)}`,
      });
    }
  }

  for (const [, v] of overrides) {
    if ((v.getFirstPropertyValue('status') || '').toString().toUpperCase() === 'CANCELLED') continue;
    const ov = new ICAL.Event(v);
    const start = ov.startDate;
    if (!start) continue;
    if (start.compare(windowEnd) >= 0) continue;
    if ((ov.endDate || start).compare(windowStart) < 0) continue;
    const recId = v.getFirstPropertyValue('recurrence-id');
    const instanceId = `uid:${ov.uid}|rid:${recId.toString()}`;
    if (out.some(e => e.instanceId === instanceId)) continue;
    out.push({
      uid: ov.uid,
      recurrenceId: recId.toString(),
      title: ov.summary || '',
      start: toIso(start),
      end: toIso(ov.endDate),
      allDay: !!start.isDate,
      instanceId,
    });
  }

  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return out;
}

export function serializeRadarMetadata(event) {
  const lines = [
    `radar-id:${event.instanceId}`,
    `radar-uid:${event.uid}`,
  ];
  if (event.recurrenceId) lines.push(`radar-rid:${event.recurrenceId}`);
  lines.push(`radar-start:${event.start}`);
  if (event.end) lines.push(`radar-end:${event.end}`);
  lines.push(`radar-all-day:${event.allDay ? 'true' : 'false'}`);
  if (event.title) lines.push(`radar-title:${event.title}`);
  if (event.source) lines.push(`radar-source:${event.source}`);
  return lines.join('\n');
}

export function parseRadarMetadata(description) {
  if (!description) return null;
  const out = {};
  for (const line of description.split('\n')) {
    const m = line.match(/^radar-([a-z-]+):(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2];
    if (key === 'id') out.id = val;
    else if (key === 'uid') out.uid = val;
    else if (key === 'rid') out.recurrenceId = val;
    else if (key === 'start') out.start = val;
    else if (key === 'end') out.end = val;
    else if (key === 'all-day') out.allDay = val === 'true';
    else if (key === 'title') out.title = val;
    else if (key === 'source') out.source = val;
  }
  if (!out.id) return null;
  return out;
}
