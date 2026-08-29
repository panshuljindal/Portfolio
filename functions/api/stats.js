/**
 * Analytics read endpoint  ->  POST /api/stats
 *
 * Reads back what functions/api/event.js writes, by querying the Workers
 * Analytics Engine SQL API. The dashboard at /stats.html renders the result.
 *
 * The Analytics Engine SQL API needs an account-scoped API token. That token
 * must never reach the browser, so the query runs here and only aggregates
 * are returned.
 *
 * Required environment (Pages -> Settings -> Environment variables):
 *   CF_ACCOUNT_ID    Cloudflare account id
 *   CF_API_TOKEN     token with "Account Analytics: Read"   (encrypt this)
 *   STATS_PASSWORD   gate for the dashboard                 (encrypt this)
 *   ANALYTICS_DATASET  dataset name used by the ANALYTICS binding
 *                      (optional, defaults to portfolio_analytics)
 *
 * Blob/double layout is defined in functions/api/event.js:
 *   blob1 type   blob2 path    blob3 label   blob4 element  blob5 href
 *   blob6 ref    blob7 session blob8 country blob9 region   blob10 device
 *   blob11 title blob12 section blob13 detail
 *   double1 value double2 scroll% double3 ms double4 vw double5 vh
 *
 * blob1 values emitted by js/analytics.js: pageview, section_view, scroll_depth,
 * read_complete, engagement, web_vital, js_error, click, outbound, download, anchor.
 */

const DEFAULT_DATASET = 'portfolio_analytics';

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

/** Length-independent compare so the response time doesn't leak the secret. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= a.charCodeAt(i % (a.length || 1)) ^ b.charCodeAt(i % (b.length || 1));
  }
  return diff === 0;
}

async function query(env, sql) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CF_API_TOKEN}`,
        'content-type': 'text/plain'
      },
      body: sql
    }
  );

  const text = await res.text();
  if (!res.ok) throw new Error(`SQL API ${res.status}: ${text.slice(0, 300)}`);

  try {
    return JSON.parse(text).data || [];
  } catch (err) {
    throw new Error(`SQL API returned non-JSON: ${text.slice(0, 200)}`);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const missing = ['CF_ACCOUNT_ID', 'CF_API_TOKEN', 'STATS_PASSWORD'].filter((k) => !env[k]);
  if (missing.length) {
    return json({ ok: false, error: `Not configured. Missing: ${missing.join(', ')}` }, 503);
  }

  let body = {};
  try {
    body = await request.json();
  } catch (err) {
    return json({ ok: false, error: 'Bad request body.' }, 400);
  }

  if (!safeEqual(String(body.password || ''), String(env.STATS_PASSWORD))) {
    return json({ ok: false, error: 'Wrong password.' }, 401);
  }

  // Clamp: Analytics Engine retains 90 days.
  const days = Math.min(Math.max(parseInt(body.days, 10) || 7, 1), 90);
  const ds = env.ANALYTICS_DATASET || DEFAULT_DATASET;
  const since = `timestamp > now() - INTERVAL '${days}' DAY`;

  // SUM(_sample_interval) rather than count(): Analytics Engine samples at
  // high volume, and the sample interval is the weight that undoes it.
  const q = {
    totals: `SELECT blob1 AS kind, SUM(_sample_interval) AS hits
             FROM ${ds} WHERE ${since} GROUP BY blob1 ORDER BY hits DESC`,
    daily: `SELECT toDate(timestamp) AS day, SUM(_sample_interval) AS hits
            FROM ${ds} WHERE ${since} AND blob1 = 'pageview'
            GROUP BY day ORDER BY day`,
    pages: `SELECT blob2 AS path, SUM(_sample_interval) AS hits
            FROM ${ds} WHERE ${since} AND blob1 = 'pageview'
            GROUP BY path ORDER BY hits DESC LIMIT 20`,
    countries: `SELECT blob8 AS country, SUM(_sample_interval) AS hits
                FROM ${ds} WHERE ${since} AND blob1 = 'pageview'
                GROUP BY country ORDER BY hits DESC LIMIT 15`,
    referrers: `SELECT blob6 AS ref, SUM(_sample_interval) AS hits
                FROM ${ds} WHERE ${since} AND blob1 = 'pageview' AND blob6 != ''
                GROUP BY ref ORDER BY hits DESC LIMIT 15`,
    devices: `SELECT blob10 AS device, SUM(_sample_interval) AS hits
              FROM ${ds} WHERE ${since} AND blob1 = 'pageview'
              GROUP BY device ORDER BY hits DESC`,
    sections: `SELECT blob12 AS section, SUM(_sample_interval) AS hits
               FROM ${ds} WHERE ${since} AND blob1 = 'section_view' AND blob12 != ''
               GROUP BY section ORDER BY hits DESC LIMIT 20`,
    clicks: `SELECT blob1 AS kind, blob3 AS label, SUM(_sample_interval) AS hits
             FROM ${ds} WHERE ${since} AND blob3 != ''
             AND blob1 IN ('click', 'outbound', 'download', 'anchor')
             GROUP BY kind, label ORDER BY hits DESC LIMIT 25`,
    vitals: `SELECT blob3 AS metric, AVG(double1) AS avg, MAX(double1) AS worst,
                    SUM(_sample_interval) AS hits
             FROM ${ds} WHERE ${since} AND blob1 = 'web_vital' AND blob3 != ''
             GROUP BY metric ORDER BY metric`,
    depth: `SELECT blob3 AS bucket, SUM(_sample_interval) AS hits
            FROM ${ds} WHERE ${since} AND blob1 = 'scroll_depth' AND blob3 != ''
            GROUP BY bucket ORDER BY bucket`,
    // One row per session; the row count is the visitor count.
    sessions: `SELECT blob7 AS sid FROM ${ds} WHERE ${since} AND blob7 != ''
               GROUP BY sid LIMIT 10000`
  };

  const keys = Object.keys(q);
  const results = await Promise.allSettled(keys.map((k) => query(env, q[k])));

  const data = {};
  const errors = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') data[keys[i]] = r.value;
    else {
      data[keys[i]] = [];
      errors[keys[i]] = r.reason.message;
    }
  });

  data.sessionCount = data.sessions.length;
  delete data.sessions;

  return json({ ok: true, days, data, errors: Object.keys(errors).length ? errors : undefined });
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return json({ ok: false, error: 'POST only.' }, 405);
}
