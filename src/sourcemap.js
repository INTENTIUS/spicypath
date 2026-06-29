// FG-044: Source map v3 decoder + profile remapper.
// Pure JS — no node: imports, usable in both the browser and the Node test harness.
//
// Public API:
//   parseSourceMap(jsonTextOrObject) → ParsedMap
//   remapProfile(profile, mapsByGenFile) → Profile
//
// ParsedMap shape:
//   { file, sourceRoot, sources[], sourcesContent[]|null, names[], lookup(genLine1, genCol0) }
//
// lookup returns { source, originalLine (1-based), originalColumn (0-based), name|null } or null.

// ---------------------------------------------------------------------------
// VLQ base64 decoder
// ---------------------------------------------------------------------------

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_VAL = new Uint8Array(128);
for (let i = 0; i < BASE64.length; i++) B64_VAL[BASE64.charCodeAt(i)] = i;

// Decode one or more VLQ base64 integers from `str` starting at `pos`.
// Reads until hitting a comma (44), semicolon (59), or end of string.
// Each integer is encoded as one or more sextets:
//   - bit 5 of each sextet is the continuation bit
//   - for the first sextet, bit 0 is the sign bit (1 = negative)
//   - the magnitude is built from bits 1-4 of the first sextet + bits 0-4 of continuation sextets
// Returns { values: number[], end: number } where end points past the last consumed char.
function decodeVLQGroup(str, pos) {
  const values = [];
  const len = str.length;
  while (pos < len) {
    const ch = str.charCodeAt(pos);
    if (ch === 44 || ch === 59) break; // comma or semicolon
    // Decode one VLQ integer
    let shift = 0, accum = 0;
    let hasContinuation = true;
    while (hasContinuation) {
      if (pos >= len) break;
      const sextet = B64_VAL[str.charCodeAt(pos++)];
      hasContinuation = (sextet & 0x20) !== 0;
      accum |= (sextet & 0x1f) << shift;
      shift += 5;
    }
    values.push((accum & 1) ? -(accum >>> 1) : (accum >>> 1));
  }
  return { values, end: pos };
}

// ---------------------------------------------------------------------------
// parseSourceMap
// ---------------------------------------------------------------------------

export function parseSourceMap(jsonTextOrObject) {
  const raw = typeof jsonTextOrObject === 'string' ? JSON.parse(jsonTextOrObject) : jsonTextOrObject;
  if (!raw || raw.version !== 3) throw new Error('not a source map v3');

  const file = raw.file || null;
  const sourceRoot = raw.sourceRoot || '';
  const sources = (raw.sources || []).map((s) => {
    if (!s) return s;
    // Resolve source against sourceRoot. If the source is already absolute (scheme or leading
    // slash) we keep it as-is; otherwise prepend sourceRoot with a trailing slash.
    if (sourceRoot && !/^([a-z][a-z0-9+\-.]*:\/\/|\/)/.test(s)) {
      return sourceRoot.replace(/\/?$/, '/') + s;
    }
    return s;
  });
  const sourcesContent = raw.sourcesContent || null;
  const names = raw.names || [];
  const mappingsStr = raw.mappings || '';

  // decoded[genLine0] = array of segments sorted by genCol (ascending).
  // Each segment: { genCol, srcIdx (or -1), origLine (0-based or -1), origCol, nameIdx (or -1) }
  const decoded = [];

  let genLine = 0;
  // Running state for delta decoding (reset per field per segment):
  let prevSrcIdx = 0, prevOrigLine = 0, prevOrigCol = 0, prevNameIdx = 0;
  // genCol is reset to 0 at each new generated line but accumulated within the line.
  let prevGenCol = 0;

  const mLen = mappingsStr.length;
  let pos = 0;
  while (pos < mLen) {
    const ch = mappingsStr.charCodeAt(pos);
    if (ch === 59 /* ; */) {
      // new generated line
      genLine++;
      prevGenCol = 0; // genCol resets at each line
      pos++;
      continue;
    }
    if (ch === 44 /* , */) {
      pos++;
      continue;
    }

    // Decode one segment
    const { values, end } = decodeVLQGroup(mappingsStr, pos);
    pos = end;

    if (!values.length) continue;

    prevGenCol += values[0];

    let entry;
    if (values.length >= 4) {
      prevSrcIdx  += values[1];
      prevOrigLine += values[2];
      prevOrigCol  += values[3];
      let ni = -1;
      if (values.length >= 5) { prevNameIdx += values[4]; ni = prevNameIdx; }
      entry = { genCol: prevGenCol, srcIdx: prevSrcIdx, origLine: prevOrigLine, origCol: prevOrigCol, nameIdx: ni };
    } else {
      // Generated-only segment (no source info)
      entry = { genCol: prevGenCol, srcIdx: -1, origLine: -1, origCol: -1, nameIdx: -1 };
    }

    if (!decoded[genLine]) decoded[genLine] = [];
    decoded[genLine].push(entry);
  }

  // lookup(genLine1, genCol0):
  //   genLine1 — 1-based generated line (as stored in frameTable.line)
  //   genCol0  — 0-based generated column
  // Returns { source, originalLine (1-based), originalColumn (0-based), name|null } or null.
  function lookup(genLine1, genCol0) {
    const line0 = genLine1 - 1;
    const segs = decoded[line0];
    if (!segs || !segs.length) return null;

    // Binary search: largest genCol <= genCol0
    let lo = 0, hi = segs.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (segs[mid].genCol <= genCol0) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (found < 0) return null;

    const seg = segs[found];
    if (seg.srcIdx < 0) return null;

    return {
      source: sources[seg.srcIdx] || null,
      originalLine: seg.origLine + 1,
      originalColumn: seg.origCol,
      name: seg.nameIdx >= 0 ? (names[seg.nameIdx] || null) : null,
    };
  }

  return { file, sourceRoot, sources, sourcesContent, names, decoded, lookup };
}

// ---------------------------------------------------------------------------
// remapProfile
// ---------------------------------------------------------------------------
// mapsByGenFile: Map<string (generated file basename), ParsedMap>
// Returns a new Profile with every frame/func whose file basename matches a
// loaded map rewritten to original source coordinates. Frames with no mapping
// are copied unchanged. Weights, stacks, threads, metrics, and capabilities
// are preserved exactly; no data is lost.

import { ProfileBuilder } from './model.js';

// Extract the basename from a file path.
function _basename(path) {
  if (!path) return '';
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

export function remapProfile(profile, mapsByGenFile) {
  if (!mapsByGenFile || mapsByGenFile.size === 0) return profile;

  const { stringTable, funcTable, frameTable, stackTable, threads, capabilities, metrics } = profile;

  const pb = new ProfileBuilder();

  // Build func remap: old func index → new func index.
  const nFuncs = funcTable.name.length;
  const funcRemap = new Int32Array(nFuncs);

  for (let fi = 0; fi < nFuncs; fi++) {
    const nameStr = stringTable[funcTable.name[fi]] || '';
    const fileIdx = funcTable.file[fi];
    const filePath = fileIdx >= 0 ? (stringTable[fileIdx] || '') : '';
    const line = funcTable.line[fi];
    const bn = _basename(filePath);
    const map = bn ? mapsByGenFile.get(bn) : null;

    if (map && line >= 0) {
      const mapped = map.lookup(line, 0);
      if (mapped && mapped.source) {
        funcRemap[fi] = pb.internFunc(
          pb.internString(mapped.name || nameStr),
          pb.internString(mapped.source),
          mapped.originalLine,
        );
        continue;
      }
    }
    // Copy unchanged.
    funcRemap[fi] = pb.internFunc(
      pb.internString(nameStr),
      fileIdx >= 0 ? pb.internString(filePath) : -1,
      line,
    );
  }

  // Build frame remap: old frame index → new frame index.
  const nFrames = frameTable.func.length;
  const frameRemap = new Int32Array(nFrames);

  for (let fri = 0; fri < nFrames; fri++) {
    const oldFunc = frameTable.func[fri];
    const newFunc = funcRemap[oldFunc];
    const frameLine = frameTable.line[fri];
    const inlineDepth = frameTable.inlineDepth[fri];

    const fileIdx = funcTable.file[oldFunc];
    const filePath = fileIdx >= 0 ? (stringTable[fileIdx] || '') : '';
    const bn = _basename(filePath);
    const map = bn ? mapsByGenFile.get(bn) : null;

    let newFrameLine = frameLine;
    if (map && frameLine >= 0) {
      const mapped = map.lookup(frameLine, 0);
      if (mapped) newFrameLine = mapped.originalLine;
    }

    frameRemap[fri] = pb.internFrame(newFunc, newFrameLine, inlineDepth);
  }

  // Build stack remap: old stack index → new stack index (in topological order).
  const nStacks = stackTable.frame.length;
  const stackRemap = new Int32Array(nStacks);
  for (let si = 0; si < nStacks; si++) {
    const oldFrame = stackTable.frame[si];
    const oldPrefix = stackTable.prefix[si];
    const newFrame = frameRemap[oldFrame];
    const newPrefix = oldPrefix < 0 ? -1 : stackRemap[oldPrefix];
    stackRemap[si] = pb.internStack(newFrame, newPrefix);
  }

  // Remap sample stacks in every thread.
  const newThreads = threads.map((t) => {
    const newStack = t.samples.stack.map((s) => (s < 0 ? -1 : stackRemap[s]));
    return { ...t, samples: { ...t.samples, stack: newStack } };
  });

  return pb.finish(newThreads, capabilities, metrics || []);
}
