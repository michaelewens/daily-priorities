# `/api/ical` route for `todoist-proxy` Cloudflare Worker

A minimal CORS-passthrough route to paste into the existing `todoist-proxy` Worker via the Cloudflare dashboard. No bundling, no dependencies — client parses the ICS.

## How to add it

1. Open the Cloudflare dashboard → Workers & Pages → `todoist-proxy` → **Edit code**.
2. Find the existing `fetch` handler (likely a `switch`/`if` block on `url.pathname`).
3. Add the `/api/ical` branch **before** the Todoist proxy logic so it matches first.
4. Ensure the OPTIONS preflight is handled (most existing CORS proxies already do this globally; if not, the snippet handles it).
5. Click **Save and Deploy**.

## Route snippet

Paste this alongside the existing route logic. If the file has an `export default { async fetch(request) { ... } }`, insert the `if (url.pathname === '/api/ical')` check near the top.

```js
// Add to the top of the fetch handler, right after parsing url
if (url.pathname === '/api/ical') {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  let body;
  try { body = await request.json(); }
  catch { return new Response('invalid JSON', { status: 400, headers: CORS }); }
  const rawUrl = (body?.url || '').trim();
  if (!rawUrl) return new Response('url required', { status: 400, headers: CORS });

  let target;
  try { target = new URL(rawUrl); } catch { return new Response('invalid URL', { status: 400, headers: CORS }); }
  if (target.protocol !== 'https:') return new Response('https required', { status: 400, headers: CORS });
  const allowed = new Set(['calendar.google.com', 'www.google.com', 'apidata.googleusercontent.com']);
  if (!allowed.has(target.hostname)) return new Response('host not allowed', { status: 403, headers: CORS });

  const upstream = await fetch(target.toString(), { headers: { 'User-Agent': 'daily-priorities/1.0' } });
  if (!upstream.ok) return new Response(`upstream ${upstream.status}`, { status: 502, headers: CORS });

  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
```

## Test

After deploy:

```bash
curl -sI -X POST https://todoist-proxy.michael-ewens.workers.dev/api/ical \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://calendar.google.com/calendar/ical/me2731%40columbia.edu/private-.../basic.ics"}'
```

Expect `HTTP/2 200` with `access-control-allow-origin: *` and `content-type: text/calendar`. The response body will be the raw ICS text.

## Notes

- The hostname allowlist (`calendar.google.com`, `www.google.com`, `apidata.googleusercontent.com`) is important — without it this becomes an open proxy.
- `Cache-Control: max-age=300` caches responses in Cloudflare's edge for 5 minutes. The client also throttles fetches.
- The client (`src/ical.js` in the app) does the ICS parsing — this route just unblocks CORS.
