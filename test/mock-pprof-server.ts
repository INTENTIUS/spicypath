// Minimal HTTP server for FG-028 browser tests. Serves a real captured pprof body at
// GET /debug/pprof/profile with CORS headers so the browser can fetch it cross-origin.
// Also records the last request so the test can verify ?seconds= was forwarded.
//
// FG-028 Slice B: also exposes mock Pyroscope /pyroscope/render and Parca
// /api/v1/query_range endpoints, each returning a gzip-compressed pprof body
// and recording the query params they received.
//
// Encoding notes:
//   go.pprof is already a gzip-compressed protobuf (single gzip).
//
//   /debug/pprof/profile (Slice A, browser-only test):
//     Sends gzipSync(PPROF_BODY) = double-gzip, with Content-Encoding: gzip.
//     Chrome auto-decompresses once (double→single gzip) and the JS fetch-pprof.js
//     gunzips again (single gzip → raw proto). Net: two decompresses = raw proto.
//
//   /pyroscope/render (Slice B):
//     Sends PPROF_BODY (single gzip) without Content-Encoding header, mimicking
//     Pyroscope's magic-bytes-only gzip delivery. pprofFromResponse detects magic
//     bytes and decompresses once → raw proto.
//
//   /api/v1/query_range (Slice B):
//     Returns Parca's Connect-JSON envelope { pprof: "<base64 gzipped-pprof>" }. The Parca
//     adapter unwraps base64 → bytes → gunzip → raw proto (its real decode path).
//
// Usage: const srv = await startMockPprofServer(); … srv.close();
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const PPROF_BODY = readFileSync(new URL('./data/go.pprof', import.meta.url));
// Double-gzip: used by /debug/pprof/profile so that Chrome's auto-decompress +
// fetchPprof's manual gunzip together yield raw protobuf.
const GZIPPED   = gzipSync(PPROF_BODY);

export interface MockServer {
  url: string;
  // /debug/pprof/profile fields (Slice A)
  lastSeconds: string | null;
  fetchCount: number;
  // Pyroscope /pyroscope/render fields (Slice B)
  lastPyroscopeParams: Record<string, string> | null;
  pyroscopeFetchCount: number;
  // Parca /api/v1/query_range fields (Slice B)
  lastParcaParams: Record<string, string> | null;
  parcaFetchCount: number;
  close(): void;
}

export async function startMockPprofServer(): Promise<MockServer> {
  const state = {
    lastSeconds: null as string | null,
    fetchCount: 0,
    lastPyroscopeParams: null as Record<string, string> | null,
    pyroscopeFetchCount: 0,
    lastParcaParams: null as Record<string, string> | null,
    parcaFetchCount: 0,
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const u = new URL(req.url ?? '/', 'http://x');

    // Slice A: Go /debug/pprof/profile (browser test only)
    // Sends double-gzip + Content-Encoding: gzip so Chrome auto-decompress +
    // fetchPprof's manual gunzip together give raw protobuf.
    if (u.pathname === '/debug/pprof/profile') {
      state.fetchCount++;
      state.lastSeconds = u.searchParams.get('seconds');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' });
      res.end(GZIPPED);
      return;
    }

    // Slice B: Pyroscope render endpoint
    // GET /pyroscope/render?query=<q>&from=<epoch-s>&until=<epoch-s>&format=pprof
    // Sends single-gzip PPROF_BODY without Content-Encoding; pprofFromResponse
    // detects magic bytes and decompresses once.
    if (u.pathname === '/pyroscope/render') {
      state.pyroscopeFetchCount++;
      const params: Record<string, string> = {};
      u.searchParams.forEach((v, k) => { params[k] = v; });
      state.lastPyroscopeParams = params;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(PPROF_BODY);
      return;
    }

    // Slice B: Parca query_range endpoint
    // GET /api/v1/query_range?query=<q>&start=<ms>&end=<ms>
    // Returns Parca's Connect-JSON envelope { pprof: "<base64 gzipped-pprof>" } so the
    // adapter exercises its real unwrap path (base64 → bytes → gunzip → parse).
    if (u.pathname === '/api/v1/query_range') {
      state.parcaFetchCount++;
      const params: Record<string, string> = {};
      u.searchParams.forEach((v, k) => { params[k] = v; });
      state.lastParcaParams = params;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pprof: PPROF_BODY.toString('base64') }));
      return;
    }

    res.writeHead(404); res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    // Slice A
    get lastSeconds()     { return state.lastSeconds; },
    get fetchCount()      { return state.fetchCount; },
    // Slice B — Pyroscope
    get lastPyroscopeParams()   { return state.lastPyroscopeParams; },
    get pyroscopeFetchCount()   { return state.pyroscopeFetchCount; },
    // Slice B — Parca
    get lastParcaParams()       { return state.lastParcaParams; },
    get parcaFetchCount()       { return state.parcaFetchCount; },
    close() { server.close(); },
  };
}
