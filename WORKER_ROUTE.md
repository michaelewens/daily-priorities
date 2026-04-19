# `/api/ical` route for `todoist-proxy` Cloudflare Worker

Drop this into your existing `todoist-proxy` Worker. It fetches a Google Calendar iCal URL server-side, parses it, expands recurrences to the next 5 days, and returns JSON with CORS headers. Needed because Google's ICS endpoints don't set `Access-Control-Allow-Origin`, so the client can't fetch them directly.

## Dependencies

Add to the Worker's `package.json`:

```json
{
  "dependencies": {
    "ical.js": "^2.1.0"
  }
}
```

Then redeploy the Worker.

## Route code

```js
import ICAL from 'ical.js';

const ALLOWED_HOSTS = new Set([
  'calendar.google.com',
  'www.google.com',
  'apidata.googleusercontent.com',
]);
const MAX_ICS_BYTES = 5 * 1024 * 1024; // 5MB
const WINDOW_DAYS = 5;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export async function handleIcal(request) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const rawUrl = (body?.url || '').trim();
  if (!rawUrl) return json({ error: 'url required' }, 400);

  let u;
  try { u = new URL(rawUrl); } catch { return json({ error: 'invalid URL' }, 400); }
  if (u.protocol !== 'https:') return json({ error: 'https required' }, 400);
  if (!ALLOWED_HOSTS.has(u.hostname)) return json({ error: 'host not allowed' }, 403);

  const upstream = await fetch(u.toString(), { headers: { 'User-Agent': 'daily-priorities/1.0' } });
  if (!upstream.ok) return json({ error: `upstream ${upstream.status}` }, 502);

  const lenHeader = upstream.headers.get('content-length');
  if (lenHeader && parseInt(lenHeader, 10) > MAX_ICS_BYTES) return json({ error: 'ICS too large' }, 413);

  // Read with a size cap even when no content-length is set.
  const reader = upstream.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_ICS_BYTES) { reader.cancel(); return json({ error: 'ICS too large' }, 413); }
    chunks.push(value);
  }
  const decoder = new TextDecoder('utf-8');
  const ics = decoder.decode(new Blob(chunks).arrayBuffer ? await new Blob(chunks).arrayBuffer() : concat(chunks));

  let events;
  try { events = parseEvents(ics); }
  catch (e) { return json({ error: `parse failed: ${e.message}` }, 500); }

  return new Response(JSON.stringify({ events }), {
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
}

function concat(chunks) {
  const total = chunks.reduce((a, c) => a + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out.buffer;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function parseEvents(icsText) {
  const jcal = ICAL.parse(icsText);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents('vevent');

  const now = ICAL.Time.now();
  const windowStart = now.clone();
  const windowEnd = now.clone();
  windowEnd.addDuration(ICAL.Duration.fromData({ days: WINDOW_DAYS }));

  // Split into masters (have recurrence-id or have rrule) and overrides.
  const overrides = new Map(); // key = `${uid}|${recurrence-id-iso}`
  const simpleAndMasters = [];
  for (const v of vevents) {
    const e = new ICAL.Event(v);
    if (e.isRecurrenceException()) {
      const recId = v.getFirstPropertyValue('recurrence-id');
      const key = `${e.uid}|${recId.toString()}`;
      overrides.set(key, v);
    } else {
      simpleAndMasters.push(v);
    }
  }

  const out = [];

  for (const v of simpleAndMasters) {
    const event = new ICAL.Event(v);
    if ((v.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED') continue;

    if (event.isRecurring()) {
      const iter = event.iterator();
      let next;
      let safety = 0;
      while ((next = iter.next()) && safety++ < 500) {
        if (next.compare(windowEnd) >= 0) break;
        if (next.compare(windowStart) < 0) continue;

        const overrideKey = `${event.uid}|${next.toString()}`;
        let effective;
        if (overrides.has(overrideKey)) {
          const ov = new ICAL.Event(overrides.get(overrideKey));
          if ((overrides.get(overrideKey).getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED') continue;
          effective = {
            uid: event.uid,
            recurrenceId: next.toString(),
            title: ov.summary || event.summary || '',
            start: toIso(ov.startDate),
            end: toIso(ov.endDate),
            allDay: ov.startDate.isDate,
          };
        } else {
          effective = {
            uid: event.uid,
            recurrenceId: next.toString(),
            title: event.summary || '',
            start: toIso(next),
            end: addDuration(next, event.duration),
            allDay: event.startDate.isDate,
          };
        }
        effective.instanceId = `uid:${effective.uid}|rid:${effective.recurrenceId}`;
        out.push(effective);
      }
    } else {
      const start = event.startDate;
      if (!start) continue;
      if (start.compare(windowEnd) >= 0) continue;
      const endCmp = event.endDate || start;
      if (endCmp.compare(windowStart) < 0) continue;
      out.push({
        uid: event.uid,
        recurrenceId: null,
        title: event.summary || '',
        start: toIso(start),
        end: toIso(event.endDate),
        allDay: start.isDate,
        instanceId: `uid:${event.uid}|start:${toIso(start)}`,
      });
    }
  }

  // Also include standalone overrides that fall in window if their master is outside scope.
  for (const [, v] of overrides) {
    const ov = new ICAL.Event(v);
    if ((v.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED') continue;
    const start = ov.startDate;
    if (!start) continue;
    if (start.compare(windowEnd) >= 0) continue;
    if ((ov.endDate || start).compare(windowStart) < 0) continue;
    const recId = v.getFirstPropertyValue('recurrence-id');
    const instanceId = `uid:${ov.uid}|rid:${recId.toString()}`;
    if (out.some(e => e.instanceId === instanceId)) continue; // already emitted by master loop
    out.push({
      uid: ov.uid,
      recurrenceId: recId.toString(),
      title: ov.summary || '',
      start: toIso(start),
      end: toIso(ov.endDate),
      allDay: start.isDate,
      instanceId,
    });
  }

  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return out;
}

function toIso(t) {
  if (!t) return null;
  if (t.isDate) {
    // All-day: serialize as YYYY-MM-DD
    const yyyy = String(t.year).padStart(4, '0');
    const mm = String(t.month).padStart(2, '0');
    const dd = String(t.day).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return t.toJSDate().toISOString();
}

function addDuration(time, dur) {
  if (!dur) return null;
  const t = time.clone();
  t.addDuration(dur);
  return toIso(t);
}
```

## Wire into your Worker's main handler

```js
import { handleIcal } from './ical-route.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ical') return handleIcal(request);
    // ... existing Todoist proxy logic
  }
};
```

## Test

```bash
curl -X POST https://todoist-proxy.michael-ewens.workers.dev/api/ical \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://calendar.google.com/calendar/ical/...%40group.calendar.google.com/private-.../basic.ics"}'
```

Expect JSON `{ "events": [ { "instanceId": "uid:...|rid:...", "title": "...", "start": "2026-04-19T14:00:00.000Z", ... } ] }`.

## Notes

- The `ALLOWED_HOSTS` set locks the route to Google's calendar endpoints. Add more hosts if you ever point it at other providers.
- `MAX_ICS_BYTES = 5MB` is conservative — bump if your calendar is huge.
- The 500-iteration safety cap on recurrence iterator protects against malformed `RRULE:FREQ=SECONDLY` style attacks.
- Response is cached for 5 min via `Cache-Control`. The client also throttles fetches; both layers protect the Worker.
