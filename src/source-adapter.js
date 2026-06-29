// Adapter interface for remote profile sources (FG-028 Slice B).
//
// An adapter is a plain object with this shape:
//
//   {
//     id:      string          — stable machine identifier, e.g. 'debug-pprof'
//     label:   string          — human-readable name, e.g. 'Go /debug/pprof'
//     fetchProfile(opts)       — opts is backend-specific; returns Promise<Profile>
//     describe(opts)           — opts is backend-specific; returns a short human string
//                               describing the pending request (shown in the status bar)
//   }
//
// opts always carries:
//   signal?   — AbortSignal (optional; passed through to fetch)
//   headers?  — extra HTTP headers { [name]: value } (auth, API keys, …)
//
// Backend-specific opts fields (documented per adapter):
//
//   debugPprofAdapter:
//     url     — full URL to the Go pprof endpoint
//     seconds — sampling window (default 5)
//
//   pyroscopeAdapter:
//     baseUrl — Pyroscope server root, e.g. 'http://localhost:4040'
//     query   — app name + profile type, e.g. 'myapp.cpu{}'
//     from    — Unix epoch seconds (number)
//     until   — Unix epoch seconds (number)
//
//   parcaAdapter:
//     baseUrl — Parca server root, e.g. 'http://localhost:7070'
//     query   — Parca label-selector query, e.g. 'process_cpu:cpu:nanoseconds:cpu:nanoseconds'
//     from    — Unix epoch milliseconds (number)  ← Parca uses ms
//     until   — Unix epoch milliseconds (number)
//
// Live-tail is explicitly out of scope (TODO: add a livePoll() helper here later).

import { parsePprofBytes } from './parse-pprof.js';

// Shared decode helper: given a fetch Response whose body is a pprof payload,
// read the body bytes, handle gzip if needed, and call parsePprofBytes.
//
// Both Node's fetch and Chrome auto-decompress responses when the server sets
// Content-Encoding: gzip, so by the time arrayBuffer() is called the body is
// typically already raw protobuf. If the server omits Content-Encoding but still
// sends a gzip body (as some Pyroscope builds do), we detect the gzip magic bytes
// and decompress via DecompressionStream.
//
// Used by all adapters that receive pprof bytes from a remote backend.
export async function pprofFromBytes(bytes) {
  // Magic-byte check: if the body starts with the gzip signature it wasn't
  // auto-decompressed (server sent gzip without Content-Encoding, the runtime
  // didn't auto-decompress, or it arrived base64 inside a JSON envelope).
  // Decompress with DecompressionStream.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    const piped = new Response(bytes).body.pipeThrough(ds);
    const raw = new Uint8Array(await new Response(piped).arrayBuffer());
    return parsePprofBytes(raw);
  }
  return parsePprofBytes(bytes);
}

// Decode a Response whose BODY IS the pprof payload (raw protobuf, possibly gzipped).
// Used by adapters that receive pprof bytes directly (Go /debug/pprof, Pyroscope
// render?format=pprof). Adapters with an envelope (e.g. Parca's Connect-JSON) unwrap it
// to bytes themselves and call pprofFromBytes.
export async function pprofFromResponse(response) {
  return pprofFromBytes(new Uint8Array(await response.arrayBuffer()));
}

// base64 → Uint8Array (atob exists in both Chrome and Node). For envelope unwrapping.
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
