// Pyroscope query adapter (FG-028 Slice B).
// Implements the shared adapter interface from source-adapter.js.
//
// Pyroscope's /render endpoint accepts a time-ranged query and can return a pprof
// payload when format=pprof is requested. This adapter builds that request, fetches
// it, and decodes the result via the shared pprofFromResponse helper.
//
// opts for fetchProfile / describe:
//   baseUrl  — Pyroscope server root, e.g. 'http://localhost:4040'
//   query    — app + profile type selector, e.g. 'myapp.cpu{}'
//   from     — start time as Unix epoch seconds (number)
//   until    — end time as Unix epoch seconds (number)
//   headers? — extra HTTP headers (Authorization, Bearer token, …)
//   signal?  — AbortSignal
//
// Pyroscope API reference: https://grafana.com/docs/pyroscope/latest/api/
//   GET /pyroscope/render?query=<q>&from=<epoch-s>&until=<epoch-s>&format=pprof
//
// Pagination: Pyroscope returns a single merged profile for the requested range;
// no client-side pagination is needed for the render endpoint.
//
// TODO: live-tail (streaming) is out of scope for this slice. Add a livePoll()
// wrapper here when that follow-up is scheduled.

import { pprofFromResponse } from './source-adapter.js';

export const pyroscopeAdapter = {
  id: 'pyroscope',
  label: 'Pyroscope',

  async fetchProfile(opts = {}) {
    const { baseUrl, query, from, until, headers = {}, signal } = opts;
    if (!baseUrl) throw new Error('pyroscopeAdapter: opts.baseUrl is required');
    if (!query)   throw new Error('pyroscopeAdapter: opts.query is required');
    if (from == null || until == null) throw new Error('pyroscopeAdapter: opts.from and opts.until are required');

    // Pyroscope /render returns a merged pprof for the time window.
    const params = new URLSearchParams({
      query:  String(query),
      from:   String(Math.floor(from)),
      until:  String(Math.floor(until)),
      format: 'pprof',
    });
    const url = `${baseUrl.replace(/\/$/, '')}/pyroscope/render?${params}`;

    const res = await fetch(url, { headers, signal });
    if (!res.ok) throw new Error(`pyroscope ${res.status} ${res.statusText} — ${url}`);

    return pprofFromResponse(res);
  },

  describe(opts = {}) {
    const { baseUrl = '?', query = '?', from, until } = opts;
    const host = (() => { try { return new URL(baseUrl).host; } catch { return baseUrl; } })();
    const range = (from != null && until != null)
      ? ` [${new Date(from * 1000).toISOString()} – ${new Date(until * 1000).toISOString()}]`
      : '';
    return `${host} · ${query}${range}`;
  },
};
