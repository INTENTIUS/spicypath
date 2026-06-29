// Browser/Node ingestion: bytes (+ filename) → canonical Profile. Gunzips via the web
// DecompressionStream (available in both), detects format by extension then content.
import { parseFoldedText } from './parse-folded.js';
import { parseSpeedscopeText } from './parse-speedscope.js';
import { parseCpuProfileText } from './parse-cpuprofile.js';
import { parsePprofBytes } from './parse-pprof.js';
import { parseOtlpBytes } from './parse-otlp.js';
import { parsePerfScriptText } from './parse-perf.js';

async function gunzipIfNeeded(bytes) {
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return bytes;
}

export async function ingestBytes(name, bytes) {
  const lower = (name || '').toLowerCase();
  const data = await gunzipIfNeeded(bytes);

  // extension-driven (fast path). OTLP and pprof are both protobuf, so they can't be told
  // apart by a content sniff — extension is authoritative for OTLP (checked before pprof).
  if (lower.includes('.otlp')) return parseOtlpBytes(data);
  if (/\.(pprof|pb|prof)$/.test(lower)) return parsePprofBytes(data);
  const text = new TextDecoder().decode(data);
  if (lower.endsWith('.cpuprofile')) return parseCpuProfileText(text);
  if (lower.includes('speedscope')) return parseSpeedscopeText(text);
  if (/\.(perf|perf-script)$/.test(lower)) return parsePerfScriptText(text);
  if (/\.(folded|collapsed|txt)$/.test(lower)) return parseFoldedText(text);

  // content sniff
  const head = text.slice(0, 4096);
  if (head.trimStart().startsWith('{')) {
    if (head.includes('speedscope') || head.includes('"profiles"')) return parseSpeedscopeText(text);
    if (head.includes('"nodes"') && head.includes('"timeDeltas"')) return parseCpuProfileText(text);
    if (head.includes('"nodes"')) return parseCpuProfileText(text);
  }
  if (/^[^\s;]+(;[^\s;]+)*\s+\d+\s*$/m.test(head)) return parseFoldedText(text); // "a;b;c 123"

  // last resort: assume pprof protobuf
  return parsePprofBytes(data);
}

export async function ingestFile(file) {
  return ingestBytes(file.name, new Uint8Array(await file.arrayBuffer()));
}
