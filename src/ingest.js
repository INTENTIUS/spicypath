// Browser/Node ingestion: bytes (+ filename) → canonical Profile. Gunzips via the web
// DecompressionStream (available in both), detects format by extension then content.
import { parseFoldedText } from './parse-folded.js';
import { parseSampleText } from './parse-sample.js';
import { parseSpeedscopeText } from './parse-speedscope.js';
import { parseCpuProfileText } from './parse-cpuprofile.js';
import { parsePprofBytes } from './parse-pprof.js';
import { parseOtlpBytes } from './parse-otlp.js';
import { parsePerfScriptText } from './parse-perf.js';
import { parseGeckoText } from './parse-gecko.js';
import { parseJfrBytes } from './parse-jfr.js';
import { parseHprof } from './parse-hprof.js';

async function gunzipIfNeeded(bytes) {
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return bytes;
}

export async function ingestBytes(name, bytes, opts = {}) {
  const lower = (name || '').toLowerCase();
  const data = await gunzipIfNeeded(bytes);

  // JFR: magic bytes 46 4C 52 00 ('FLR\0') at offset 0 — check before other binary formats.
  if (data.length >= 4 && data[0] === 0x46 && data[1] === 0x4c && data[2] === 0x52 && data[3] === 0x00) return parseJfrBytes(data);

  // HPROF: magic 'JAVA PROFILE 1.0.' at offset 0 — fast-path extension check first, then content sniff.
  if (lower.endsWith('.hprof')) return parseHprof(data);
  if (data.length >= 18) {
    // Check for 'JAVA PROFILE 1.0.1\0' or 'JAVA PROFILE 1.0.2\0' (17 or 18 bytes to the dot-digit)
    const hprofMagic = new TextDecoder().decode(data.subarray(0, 17));
    if (hprofMagic.startsWith('JAVA PROFILE 1.0.')) return parseHprof(data);
  }

  // extension-driven (fast path). OTLP and pprof are both protobuf, so they can't be told
  // apart by a content sniff — extension is authoritative for OTLP (checked before pprof).
  if (lower.includes('.otlp')) return parseOtlpBytes(data);
  if (/\.(pprof|pb|prof)$/.test(lower)) return parsePprofBytes(data);
  const text = new TextDecoder().decode(data);
  // macOS `sample`(1) / Instruments call-tree text has a distinctive header — sniff it before the
  // generic `.txt` → folded route, since a `sample` capture is commonly saved as a .txt file.
  if (text.startsWith('Analysis of sampling') || /^Call graph:/m.test(text.slice(0, 4096))) return parseSampleText(text);
  if (lower.endsWith('.cpuprofile')) return parseCpuProfileText(text);
  if (lower.includes('speedscope')) return parseSpeedscopeText(text);
  if (/\.(perf|perf-script)$/.test(lower)) return parsePerfScriptText(text);
  if (/\.(folded|collapsed|txt)$/.test(lower)) return parseFoldedText(text, opts);

  // content sniff
  const head = text.slice(0, 4096);
  if (head.trimStart().startsWith('{')) {
    if (head.includes('speedscope') || head.includes('"profiles"')) return parseSpeedscopeText(text);
    // Gecko: top-level "threads" array + either "meta" or "stackTable" in first thread.
    // Check before cpuprofile "nodes" — Gecko JSON never has "nodes".
    if (head.includes('"threads"') && (head.includes('"stackTable"') || head.includes('"meta"'))) return parseGeckoText(text);
    if (head.includes('"nodes"') && head.includes('"timeDeltas"')) return parseCpuProfileText(text);
    if (head.includes('"nodes"')) return parseCpuProfileText(text);
  }
  if (/^[^\s;]+(;[^\s;]+)*\s+\d+\s*$/m.test(head)) return parseFoldedText(text, opts); // "a;b;c 123"

  // last resort: assume pprof protobuf
  return parsePprofBytes(data);
}

export async function ingestFile(file) {
  return ingestBytes(file.name, new Uint8Array(await file.arrayBuffer()));
}
