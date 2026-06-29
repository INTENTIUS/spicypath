// Gecko "processed profile" JSON → canonical model (timed plane). Pure (browser + Node).
//
// SCHEMA PINNED: firefox-devtools/profiler processed profile format, meta.version 5
//   (raw Gecko format: tables use {schema, data} arrays; stringTable is an array of strings).
//   Processed format (meta.preprocessedProfileVersion present): tables use separate column
//   arrays; stringArray replaces stringTable. Both are handled transparently.
//
// Per-thread mapping:
//   stringTable / stringArray  →  b.internString
//   funcTable (name, fileName, lineNumber)  →  b.internFunc
//   frameTable (func, line, inlineDepth)    →  b.internFrame
//   stackTable (frame, prefix/null)         →  b.internStack  (already a prefix tree)
//   samples (stack, time)                   →  per-sample timed plane; hasTiming = true
//
// Tolerances:
//   - stringTable or stringArray accepted.
//   - Raw ({schema, data}) or processed (separate arrays) tables accepted.
//   - stackTable prefix null treated as -1 (root).
//   - samples may use 'time' (absolute ms) or 'timeDeltas' (cumulative ms); both round-trip.
//   - funcTable may carry fileName (processed) or no fileName (raw); gracefully absent.
//   - Threads with no samples are skipped (still valid single-thread profiles).

import { ProfileBuilder } from './model.js';

// Materialise a table that may be either raw {schema, data[]} or processed {col: []} form.
// Returns an array of objects keyed by column name.
function expandTable(tbl) {
  if (!tbl) return [];
  if (Array.isArray(tbl.data)) {
    // raw format: {schema: {col: idx, ...}, data: [[v0,v1,...], ...]}
    const schema = tbl.schema || {};
    // invert schema: idx → colName
    const cols = [];
    for (const [k, v] of Object.entries(schema)) cols[v] = k;
    return tbl.data.map((row) => {
      const obj = {};
      for (let i = 0; i < cols.length; i++) if (cols[i] !== undefined) obj[cols[i]] = row[i];
      return obj;
    });
  }
  // processed format: {col: [], length: N, ...}
  const cols = Object.keys(tbl).filter((k) => Array.isArray(tbl[k]));
  const len = cols.length ? tbl[cols[0]].length : 0;
  const rows = [];
  for (let i = 0; i < len; i++) {
    const obj = {};
    for (const c of cols) obj[c] = tbl[c][i];
    rows.push(obj);
  }
  return rows;
}

// Get samples as an array of objects. Samples may be raw {schema,data} or processed column arrays.
// Returns [{stack, time}, ...]. time is derived from 'time' column (ms) or cumsum of 'timeDeltas'.
function expandSamples(samples) {
  if (!samples) return [];
  let rows;
  if (Array.isArray(samples.data)) {
    const schema = samples.schema || {};
    const cols = [];
    for (const [k, v] of Object.entries(schema)) cols[v] = k;
    rows = samples.data.map((row) => {
      const obj = {};
      for (let i = 0; i < cols.length; i++) if (cols[i] !== undefined) obj[cols[i]] = row[i];
      return obj;
    });
  } else {
    // processed: separate arrays
    const n = (samples.stack || samples.time || samples.timeDeltas || []).length;
    rows = [];
    for (let i = 0; i < n; i++) {
      const obj = {};
      if (samples.stack) obj.stack = samples.stack[i];
      if (samples.time) obj.time = samples.time[i];
      if (samples.timeDeltas) obj.timeDeltas = samples.timeDeltas[i];
      if (samples.weight) obj.weight = samples.weight[i];
      rows.push(obj);
    }
  }

  // Reconstruct absolute time if only timeDeltas are present
  if (rows.length && rows[0].timeDeltas !== undefined && rows[0].time === undefined) {
    let cur = 0;
    for (const r of rows) { cur += r.timeDeltas || 0; r.time = cur; }
  }
  return rows;
}

export function parseGeckoText(text) {
  const j = JSON.parse(text);
  const threads = j.threads || [];

  const b = new ProfileBuilder();
  const outThreads = [];

  for (const thread of threads) {
    // String table: raw uses 'stringTable', processed uses 'stringArray'
    const strtab = thread.stringArray || thread.stringTable || [];

    const funcRows = expandTable(thread.funcTable);
    const frameRows = expandTable(thread.frameTable);
    const stackRows = expandTable(thread.stackTable);
    const sampleRows = expandSamples(thread.samples);

    if (sampleRows.length === 0) continue;

    // Intern funcs. funcTable.name is an index into strtab.
    // fileName may be an index into strtab (processed) or absent (raw).
    const funcIdx = [];
    for (let i = 0; i < funcRows.length; i++) {
      const f = funcRows[i];
      const nameStr = strtab[f.name] || '?';
      const fileStr = (f.fileName != null) ? (strtab[f.fileName] || '') : '';
      const line = (f.lineNumber != null) ? f.lineNumber : -1;
      funcIdx.push(b.internFunc(b.internString(nameStr), b.internString(fileStr), line));
    }

    // In the raw format, frameTable.location is an index into stringTable (the human-readable
    // "pkg::func" string), and there is no func column. In the processed format, frameTable.func
    // is an index into funcTable.
    // Detect which form we have:
    const isRawFrame = frameRows.length > 0 && frameRows[0].func === undefined && frameRows[0].location !== undefined;

    // Cache for raw-format: location string → funcIdx (create funcs on demand)
    const rawFuncCache = new Map();

    const frameIdx = [];
    for (let i = 0; i < frameRows.length; i++) {
      const fr = frameRows[i];
      let fi;
      if (isRawFrame) {
        // location is a string-table index containing the frame label
        const label = strtab[fr.location] || '?';
        if (!rawFuncCache.has(label)) {
          rawFuncCache.set(label, b.internFunc(b.internString(label), b.internString(''), -1));
        }
        fi = rawFuncCache.get(label);
      } else {
        fi = funcIdx[fr.func] !== undefined ? funcIdx[fr.func] : funcIdx[0];
      }
      const line = (fr.line != null) ? fr.line : -1;
      const inlineDepth = (fr.inlineDepth != null) ? fr.inlineDepth : 0;
      frameIdx.push(b.internFrame(fi, line, inlineDepth));
    }

    // Build stack index. stackTable prefix is null (raw) or -1 (processed) for roots.
    // We must build in order (prefix always < current index — Gecko guarantees this).
    const stackIdx = [];
    for (let i = 0; i < stackRows.length; i++) {
      const s = stackRows[i];
      const fi = frameIdx[s.frame];
      const pfx = (s.prefix == null || s.prefix === -1) ? -1 : stackIdx[s.prefix];
      stackIdx.push(b.internStack(fi, pfx));
    }

    // Build samples. A Gecko sample is one tick → weight type is 'samples' (each sample = 1,
    // or the explicit 'weight' column when present), not cpu_nanos. timeUnit carries the ms axis.
    const stack = [], time = [], samples = [];
    for (const s of sampleRows) {
      const si = s.stack;
      if (si == null) continue; // idle sample
      const mapped = stackIdx[si];
      if (mapped === undefined) continue;
      stack.push(mapped);
      time.push(s.time != null ? s.time : 0);
      // weight: if present use it; otherwise 1 sample tick
      samples.push(s.weight != null ? s.weight : 1);
    }

    if (stack.length === 0) continue;

    outThreads.push({
      name: thread.name || 'main',
      samples: { stack, weightsByType: { samples }, time },
    });
  }

  if (outThreads.length === 0) {
    // Fallback: return an empty but valid profile
    return b.finish([{ name: 'main', samples: { stack: [], weightsByType: { samples: [] }, time: [] } }],
      { hasTiming: true, weightTypes: ['samples'], timeUnit: 'milliseconds', isDiff: false });
  }

  return b.finish(outThreads, { hasTiming: true, weightTypes: ['samples'], timeUnit: 'milliseconds', isDiff: false });
}
