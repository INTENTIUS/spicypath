// Parca query adapter (FG-028 Slice B).
// Implements the shared adapter interface from source-adapter.js.
//
// Parca supports a REST/Connect-Web query layer. The simplest HTTP path that returns
// pprof bytes is the /query_range endpoint (or /query for single-instant). This
// adapter uses /query_range to fetch a merged profile over a time window and decodes
// it via the shared pprofFromResponse helper.
//
// opts for fetchProfile / describe:
//   baseUrl  — Parca server root, e.g. 'http://localhost:7070'
//   query    — Parca selector string, e.g.
//              'process_cpu:cpu:nanoseconds:cpu:nanoseconds{job="myservice"}'
//   from     — start time as Unix epoch milliseconds (number)
//   until    — end time as Unix epoch milliseconds (number)
//   headers? — extra HTTP headers (Authorization, Bearer token, …)
//   signal?  — AbortSignal
//
// RESPONSE shape (the part this adapter decodes faithfully): Parca's query API is
// ConnectRPC. A QueryService/Query with report_type = REPORT_TYPE_PPROF returns a
// QueryResponse whose pprof variant is a `bytes pprof` field; over Connect's JSON codec
// that is base64-encoded — i.e. `{ "pprof": "<base64 gzipped-pprof>" }`. This adapter
// unwraps that envelope (base64 → bytes → gunzip → parsePprofBytes), and also accepts a
// raw pprof body (some deployments / proxies return octet-stream) as a fallback.
//
// REQUEST shape (version-specific — CONFIRM against your Parca): the real call is a
// Connect unary POST to QueryService/Query. To keep the adapter simple and testable we
// issue GET /api/v1/query_range with the query + time range as params; swap this one line
// for the Connect POST your deployment expects. The decode above is the substantive part.
//
// Pagination: Parca merges the full range server-side; no client pagination needed.
// TODO: live-tail (streaming) is out of scope for this slice.

import { pprofFromResponse, pprofFromBytes, base64ToBytes } from './source-adapter.js';

// Unwrap a Parca query response into a canonical Profile. Connect-JSON carries the pprof
// bytes base64-encoded in a `pprof` (or `report`) field; otherwise the body is raw pprof.
async function parcaProfileFrom(res) {
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('json')) {
    const env = await res.json();
    const b64 = env.pprof ?? env.report ?? env.data;
    if (typeof b64 !== 'string') throw new Error('parca: JSON response missing base64 pprof field');
    return pprofFromBytes(base64ToBytes(b64));
  }
  return pprofFromResponse(res); // raw octet-stream fallback
}

export const parcaAdapter = {
  id: 'parca',
  label: 'Parca',

  async fetchProfile(opts = {}) {
    const { baseUrl, query, from, until, headers = {}, signal } = opts;
    if (!baseUrl) throw new Error('parcaAdapter: opts.baseUrl is required');
    if (!query)   throw new Error('parcaAdapter: opts.query is required');
    if (from == null || until == null) throw new Error('parcaAdapter: opts.from and opts.until are required');

    // /api/v1/query_range: merged profile over [from, until].
    // Times are sent as Unix millisecond epoch strings.
    const params = new URLSearchParams({
      query: String(query),
      start: String(Math.floor(from)),
      end:   String(Math.floor(until)),
    });
    const url = `${baseUrl.replace(/\/$/, '')}/api/v1/query_range?${params}`;

    const res = await fetch(url, { headers, signal });
    if (!res.ok) throw new Error(`parca ${res.status} ${res.statusText} — ${url}`);

    return parcaProfileFrom(res);
  },

  describe(opts = {}) {
    const { baseUrl = '?', query = '?', from, until } = opts;
    const host = (() => { try { return new URL(baseUrl).host; } catch { return baseUrl; } })();
    const range = (from != null && until != null)
      ? ` [${new Date(from).toISOString()} – ${new Date(until).toISOString()}]`
      : '';
    return `${host} · ${query}${range}`;
  },
};
