// Live /debug/pprof adapter (FG-028 Slice A).
// fetchPprof(url, opts) → Promise<Profile>
//   url     – full URL, e.g. 'http://localhost:6060/debug/pprof/profile'
//   opts.seconds – sampling window (default 5); appended as ?seconds=N
//   opts.headers – extra HTTP headers (Authorization, X-Api-Key, …)
//
// The Go net/http/pprof handler returns gzip-compressed protobuf; this adapter:
//   1. GETs the URL (with ?seconds=N so the server collects a fresh sample)
//   2. Decompresses the gzip response via the browser's DecompressionStream API
//   3. Feeds raw bytes to parsePprofBytes (the same parser used for file drops)
//   4. Returns a canonical Profile ready for the UI
//
// CORS: the target server must allow the browser's origin. For local dev the Go
// runtime's default pprof handler doesn't add CORS headers; patch it with one line
// (see README) or run spicypath from the same origin. A thin proxy is the fallback.
import { parsePprofBytes } from './parse-pprof.js';

const DEFAULT_SECONDS = 5;

// Decompress a gzip Response body using the browser's Streams API (no dep).
async function gunzip(response) {
  const ds = new DecompressionStream('gzip');
  const piped = response.body.pipeThrough(ds);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

export async function fetchPprof(url, opts = {}) {
  const seconds = opts.seconds ?? DEFAULT_SECONDS;
  const headers = opts.headers ?? {};
  const sep = url.includes('?') ? '&' : '?';
  const fullUrl = `${url}${sep}seconds=${seconds}`;

  const res = await fetch(fullUrl, { headers, signal: opts.signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${fullUrl}`);

  // pprof responses are always gzip; handle both for robustness.
  const enc = (res.headers.get('content-encoding') || '').toLowerCase();
  const bytes = enc === 'gzip' || enc === 'x-gzip'
    ? await gunzip(res)
    : new Uint8Array(await res.arrayBuffer());

  return parsePprofBytes(bytes);
}
