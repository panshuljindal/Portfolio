/**
 * Analytics collection endpoint  ->  POST /api/event
 *
 * Writes batched client events into a Workers Analytics Engine dataset.
 *
 * Requires an Analytics Engine binding named ANALYTICS on the Pages project
 * (Settings -> Bindings -> Analytics Engine). If the binding is missing this
 * endpoint stays silent and returns 204, so the site never breaks because
 * analytics is unconfigured.
 *
 * Analytics Engine limits that shape this file:
 *   - 250 data points per invocation
 *   - 20 blobs + 20 doubles per data point, 16KB of blobs total
 *   - exactly 1 index, which must be under 96 bytes
 */

const MAX_EVENTS = 250; // hard platform cap per invocation
const MAX_BLOB = 256;   // per-field trim; keeps us well under the 16KB blob budget
const MAX_INDEX = 90;   // platform cap is 96 bytes

function noContent() {
  return new Response(null, {
    status: 204,
    headers: { 'cache-control': 'no-store' }
  });
}

function str(v, max) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : String(v);
  return s.length > (max || MAX_BLOB) ? s.slice(0, max || MAX_BLOB) : s;
}

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    if (!env || !env.ANALYTICS) return noContent();

    const body = await request.json();
    const list = body && Array.isArray(body.events) ? body.events : [];
    if (!list.length) return noContent();

    const cf = request.cf || {};
    // Server-derived so the client can't spoof geo, and so we never store an IP.
    const country = str(cf.country, 8);
    const region = str(cf.region, 64);
    const sessionRaw = str(body.sid, MAX_INDEX);

    for (const ev of list.slice(0, MAX_EVENTS)) {
      if (!ev || typeof ev !== 'object') continue;

      env.ANALYTICS.writeDataPoint({
        // Single index drives read-time sampling; session keeps per-visit
        // queries accurate without ever identifying a person.
        indexes: [sessionRaw || 'anon'],
        blobs: [
          str(ev.t),        // 1  event type
          str(ev.p),        // 2  path
          str(ev.l),        // 3  label
          str(ev.el, 64),   // 4  element descriptor
          str(ev.h, 512),   // 5  href / target
          str(body.ref, 512), // 6 referrer
          sessionRaw,       // 7  session id
          country,          // 8  country
          region,           // 9  region
          str(body.dev, 16),// 10 device class
          str(body.ttl),    // 11 page title
          str(ev.s, 64),    // 12 section id
          str(ev.d)         // 13 free-form detail
        ],
        doubles: [
          num(ev.v),        // 1  primary value (vital score, error count, ...)
          num(ev.sc),       // 2  scroll percent
          num(ev.ms),       // 3  duration in ms
          num(body.vw),     // 4  viewport width
          num(body.vh),     // 5  viewport height
          num(ev.ts)        // 6  client timestamp
        ]
      });
    }
  } catch (err) {
    // Swallow everything: a bad payload must never surface to the visitor.
  }

  return noContent();
}

// Beacons only ever POST; answer anything else cheaply.
export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return noContent();
}
