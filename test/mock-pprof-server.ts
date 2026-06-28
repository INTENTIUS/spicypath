// Minimal HTTP server for FG-028 browser tests. Serves a real captured pprof body at
// GET /debug/pprof/profile with CORS headers so the browser can fetch it cross-origin.
// Also records the last request so the test can verify ?seconds= was forwarded.
// Usage: const srv = await startMockPprofServer(); … srv.close();
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const PPROF_BODY = readFileSync(new URL('./data/go.pprof', import.meta.url));
const GZIPPED   = gzipSync(PPROF_BODY); // real pprof servers send gzip

export interface MockServer {
  url: string;
  lastSeconds: string | null;
  fetchCount: number;
  close(): void;
}

export async function startMockPprofServer(): Promise<MockServer> {
  const state = { lastSeconds: null as string | null, fetchCount: 0 };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.url?.startsWith('/debug/pprof/profile')) {
      state.fetchCount++;
      const u = new URL(req.url, 'http://x');
      state.lastSeconds = u.searchParams.get('seconds');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' });
      res.end(GZIPPED);
    } else {
      res.writeHead(404); res.end('not found');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    get lastSeconds() { return state.lastSeconds; },
    get fetchCount()  { return state.fetchCount; },
    close() { server.close(); },
  };
}
