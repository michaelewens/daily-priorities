import ICAL from 'ical.js';

const PROXY_BASE = 'https://todoist-proxy.michael-ewens.workers.dev';
const CACHE_KEY = 'dps_ics_cache';
const THROTTLE_MS = 5 * 60 * 1000;
const WINDOW_DAYS = 5;

let lastFetchAt = 0;
let lastFetchUrl = '';
let inFlight = null;

export function normalizeIcsUrl(raw) {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (trimmed.startsWith('webcal://')) return 'https://' + trimmed.slice('webcal://'.length);
  if (trimmed.startsWith('webcals://')) return 'https://' + trimmed.slice('webcals://'.length);
  return trimmed;
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { url, events, at } = JSON.parse(raw);
    return { url, events: events || [], at: at || 0 };
  } catch {
    return null;
  }
}

function saveCache(url, events) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ url, events, at: Date.now() }));
  } catch (e) { void e; /* localStorage full or unavailable */ }
}

export function getCachedEvents(url) {
  const c = loadCache();
  if (!c || c.url !== url) return [];
  return c.events;
}

export async function fetchEvents(rawUrl, { force = false } = {}) {
  const url = normalizeIcsUrl(rawUrl);
  if (!url) return [];

  const now = Date.now();
  const urlChanged = url !== lastFetchUrl;
  const stale = now - lastFetchAt > THROTTLE_MS;
  if (!force && !urlChanged && !stale && inFlight) return inFlight;
  if (!force && !urlChanged && !stale) {
    const cached = getCachedEvents(url);
    if (cached.length) return cached;
  }

  inFlight = (async () => {
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
    lastFetchAt = Date.now();
    lastFetchUrl = url;
    saveCache(url, events);
    return events;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
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
  }
  if (!out.id) return null;
  return out;
}
