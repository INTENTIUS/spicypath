// JDK Flight Recorder (.jfr) binary → canonical model (timed plane). Pure browser/Node.
// Format: one or more chunks. Chunk header (68 bytes, big-endian) holds magic, version,
// chunkSize, cpOffset, metaOffset, startTimeNanos, startTicks, ticksPerSecond. Inside a
// chunk, integers are LEB128 (little-endian base-128 varints, up to 9 bytes). typeId=0:
// metadata event (string table + element tree defining the type schema); typeId=1:
// checkpoint/constant-pool event; other typeIds: data events.
//
// FG-052 — additional stack-bearing sample events (event names are JDK-version-dependent;
// we look them up by name from the metadata schema and skip if absent):
//
//   jdk.ObjectAllocationSample       → weight field "weight"         (bytes) → alloc_bytes
//   jdk.ObjectAllocationInNewTLAB    → weight field "allocationSize" (bytes) → alloc_bytes
//   jdk.ObjectAllocationOutsideTLAB  → weight field "allocationSize" (bytes) → alloc_bytes
//   jdk.JavaMonitorEnter             → weight field "duration"  (TICKS→ns)   → monitor_nanos
//   jdk.JavaMonitorWait              → weight field "duration"  (TICKS→ns)   → monitor_nanos
//   jdk.ThreadPark                   → weight field "duration"  (TICKS→ns)   → park_nanos
//
// All events share the same stackTrace CP-ref field and startTime field; stacks are resolved
// identically to ExecutionSample. Duration fields use TICKS that are converted to nanoseconds
// with the chunk's ticksPerSecond. The unified sample stream is sorted by time so time[] is
// non-decreasing across all weight types.
import { ProfileBuilder } from './model.js';

// --- Big-endian chunk header ------------------------------------------------

const CHUNK_HDR_SIZE = 68;
const MAGIC = 0x464c5200; // 'FLR\0'

function readChunkHeader(buf, pos) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = dv.getUint32(pos, false);
  if (magic !== MAGIC) throw new Error(`Bad JFR magic 0x${magic.toString(16)}`);
  function i64(off) {
    // Read 8-byte big-endian signed int as JS Number (safe for values we use)
    const hi = dv.getInt32(pos + off, false);
    const lo = dv.getUint32(pos + off + 4, false);
    return hi * 4294967296 + lo;
  }
  return {
    chunkSize:      i64(8),
    cpOffset:       i64(16),  // unused (we scan all events)
    metaOffset:     i64(24),
    startTimeNanos: i64(32),
    startTicks:     i64(48),
    ticksPerSecond: i64(56),
  };
}

// --- LEB128 varint ----------------------------------------------------------

// Reads an unsigned LEB128 varint as a JS Number.
// Safe up to 2^53 which covers all practical JFR values.
function readVarlong(buf, pos) {
  let val = 0, shift = 0;
  for (let i = 0; i < 9; i++) {
    const b = buf[pos++];
    if (i < 8) {
      val += (b & 0x7f) * Math.pow(2, shift);
      shift += 7;
      if (!(b & 0x80)) break;
    } else {
      val += b * Math.pow(2, shift); // 9th byte: all 8 bits
    }
  }
  return [val, pos];
}

// --- String encoding --------------------------------------------------------

// JFR string tag:
//  0=null, 1="", 2=cp-ref(varint index into String pool), 3=UTF8 [len][bytes],
//  4=char-array [len][char-varints], 5=Latin1 [len][bytes]
function readStringField(buf, pos) {
  const tag = buf[pos++];
  if (tag === 0) return [null, pos];
  if (tag === 1) return ['', pos];
  if (tag === 2) {
    const [idx, p2] = readVarlong(buf, pos);
    return [{ cpRef: idx }, p2];
  }
  if (tag === 3) {
    const [len, p2] = readVarlong(buf, pos);
    const s = new TextDecoder().decode(buf.subarray(p2, p2 + len));
    return [s, p2 + len];
  }
  if (tag === 4) {
    const [len, p2] = readVarlong(buf, pos);
    let p = p2, s = '';
    for (let i = 0; i < len; i++) { const [c, np] = readVarlong(buf, p); s += String.fromCodePoint(c); p = np; }
    return [s, p];
  }
  if (tag === 5) {
    const [len, p2] = readVarlong(buf, pos);
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(buf[p2 + i]);
    return [s, p2 + len];
  }
  return [null, pos]; // unknown tag, skip
}

// Same but for metadata string table (no cp-ref variant needed, but reuse same fn)
const readMetaString = readStringField;

// --- Metadata event ---------------------------------------------------------

function parseMetadata(buf, metaStart) {
  // [size:vi][typeId=0:vi][startTime:vi][duration:vi][metaId:vi]
  // [strCount:vi][string*]
  // [root element tree]
  let p = metaStart;
  [, p] = readVarlong(buf, p); // size
  [, p] = readVarlong(buf, p); // typeId
  [, p] = readVarlong(buf, p); // startTime
  [, p] = readVarlong(buf, p); // duration
  [, p] = readVarlong(buf, p); // metaId

  let [strCount, p2] = readVarlong(buf, p);
  p = p2;
  const strings = [];
  for (let i = 0; i < strCount; i++) {
    const [s, np] = readMetaString(buf, p);
    strings.push(s);
    p = np;
  }

  // Recursive element reader
  function readElement(pos) {
    const [nameIdx, p1] = readVarlong(buf, pos);
    const name = strings[nameIdx] || '';
    const [attrCount, p2] = readVarlong(buf, p1);
    let p = p2;
    const attrs = {};
    for (let i = 0; i < attrCount; i++) {
      const [ki, p3] = readVarlong(buf, p);
      const [vi, p4] = readVarlong(buf, p3);
      attrs[strings[ki]] = strings[vi];
      p = p4;
    }
    const [childCount, p5] = readVarlong(buf, p);
    p = p5;
    const children = [];
    for (let i = 0; i < childCount; i++) {
      const [child, np] = readElement(p);
      children.push(child);
      p = np;
    }
    return [{ name, attrs, children }, p];
  }

  const [root] = readElement(p);

  // Build class schema map: classId -> { name, fields }
  // fields: [{name, classId, isCP, isArray}] — only serialized (non-settings) named fields.
  const classes = new Map();
  const metaEl = root.children.find(c => c.name === 'metadata');
  if (!metaEl) return classes;

  for (const cls of metaEl.children) {
    const a = cls.attrs;
    const cid = parseInt(a.id || '0', 10);
    const clsName = a.name || '';
    const fields = [];
    for (const f of cls.children) {
      const fa = f.attrs;
      if (!('name' in fa)) continue;       // annotation element (no name attr)
      if ('defaultValue' in fa) continue;  // settings field (not in data stream)
      fields.push({
        name: fa.name,
        classId: parseInt(fa.class, 10),
        isCP: fa.constantPool === 'true',
        isArray: 'dimension' in fa,
      });
    }
    classes.set(cid, { name: clsName, fields });
  }
  return classes;
}

// --- Schema-driven value reader ---------------------------------------------

const PRIM_NAMES = new Set(['long', 'int', 'short', 'char', 'byte', 'boolean', 'float', 'double']);
const BYTE_NAME = 'byte';

function makeValueReader(classes) {
  function readValue(buf, pos, cid) {
    const cls = classes.get(cid);
    // java.lang.String has no schema fields but uses the special string encoding.
    // Check it before the fields.length guard to avoid falling through to varint.
    if (cls && cls.name === 'java.lang.String') {
      return readStringField(buf, pos);
    }
    // Primitive or unknown: varint
    if (!cls || PRIM_NAMES.has(cls.name) || cls.fields.length === 0) {
      return readVarlong(buf, pos);
    }
    // Composite
    const obj = {};
    for (const f of cls.fields) {
      if (f.isCP) {
        const [idx, np] = readVarlong(buf, pos);
        obj[f.name] = idx;  // raw cp index; resolve later
        pos = np;
      } else if (f.isArray) {
        const [count, p2] = readVarlong(buf, pos);
        pos = p2;
        const items = [];
        // Byte arrays in JFR are stored as raw bytes, not varints
        const itemCls = classes.get(f.classId);
        if (itemCls && itemCls.name === BYTE_NAME) {
          for (let i = 0; i < count; i++) items.push(buf[pos++]);
        } else {
          for (let i = 0; i < count; i++) {
            const [v, np] = readValue(buf, pos, f.classId);
            items.push(v);
            pos = np;
          }
        }
        obj[f.name] = items;
      } else {
        const [v, np] = readValue(buf, pos, f.classId);
        obj[f.name] = v;
        pos = np;
      }
    }
    return [obj, pos];
  }
  return readValue;
}

// --- Checkpoint parser -------------------------------------------------------

function parseCheckpoints(buf, classes, chunkStart, chunkEnd) {
  // Returns a Map: classId -> Map(idx -> value)
  const pools = new Map();
  const readValue = makeValueReader(classes);

  let p = chunkStart + CHUNK_HDR_SIZE;
  while (p < chunkEnd) {
    const eventStart = p;
    const [size, p2] = readVarlong(buf, p);
    if (size === 0) break;
    const eventEnd = eventStart + size;
    if (eventEnd > chunkEnd) break;

    const [typeId, p3] = readVarlong(buf, p2);

    if (typeId === 1) {
      // Checkpoint: [startTime:vi][duration:vi][delta:vi][typeMask:vi][poolCount:vi][pool*]
      // pool: [classId:vi][count:vi][entry*]; entry: [idx:vi][fields per schema]
      let pp = p3;
      [, pp] = readVarlong(buf, pp); // startTime
      [, pp] = readVarlong(buf, pp); // duration
      [, pp] = readVarlong(buf, pp); // delta
      [, pp] = readVarlong(buf, pp); // typeMask
      const [poolCount, pp2] = readVarlong(buf, pp);
      pp = pp2;

      for (let pi = 0; pi < poolCount && pp < eventEnd; pi++) {
        const [classId, pp3] = readVarlong(buf, pp);
        const [count, pp4] = readVarlong(buf, pp3);
        pp = pp4;

        if (!pools.has(classId)) pools.set(classId, new Map());
        const pool = pools.get(classId);

        for (let ci = 0; ci < count && pp < eventEnd; ci++) {
          const [idx, pp5] = readVarlong(buf, pp);
          pp = pp5;
          try {
            const [val, pp6] = readValue(buf, pp, classId);
            pool.set(idx, val);
            pp = pp6;
          } catch (_) {
            // Unrecognised pool layout — bail out of this checkpoint
            pp = eventEnd;
            break;
          }
        }
      }
    }

    p = eventEnd;
  }

  return pools;
}

// --- Constant-pool resolver -------------------------------------------------

function makeResolver(pools, classes) {
  // Look up a type's field info to know which classId to use when resolving cp refs
  // For Method (192-ish), Class (190-ish), Symbol (193-ish) we need their actual IDs.
  // We find them from classes by name.
  let symbolClassId = -1, classClassId = -1, stringClassId = -1;
  for (const [id, cls] of classes) {
    if (cls.name === 'jdk.types.Symbol')   symbolClassId = id;
    if (cls.name === 'java.lang.Class')    classClassId = id;
    if (cls.name === 'java.lang.String')   stringClassId = id;
  }

  function resolveRaw(classId, idx) {
    const pool = pools.get(classId);
    return pool ? pool.get(idx) : undefined;
  }

  function resolveString(val) {
    if (val == null) return null;
    if (typeof val === 'string') return val;
    if (typeof val === 'object' && 'cpRef' in val) {
      // String cp ref into the String pool (class = stringClassId or 239)
      const sid = stringClassId >= 0 ? stringClassId : 239;
      const s = resolveRaw(sid, val.cpRef);
      if (typeof s === 'string') return s;
      if (s && typeof s === 'object' && 'cpRef' in s) return resolveRaw(sid, s.cpRef);
    }
    return null;
  }

  function resolveSymbol(idx) {
    if (symbolClassId < 0) return null;
    const sym = resolveRaw(symbolClassId, idx);
    if (!sym) return null;
    return resolveString(sym.string);
  }

  function resolveClassName(idx) {
    if (classClassId < 0) return null;
    const cls = resolveRaw(classClassId, idx);
    if (!cls) return null;
    return resolveSymbol(cls.name);
  }

  return { resolveRaw, resolveString, resolveSymbol, resolveClassName };
}

// --- Generic event field reader ---------------------------------------------
//
// For any stack-bearing sample event: scan its fields and extract
//   startTime (ticks), stackTrace (CP index), eventThread (CP index), and a named weight field.
// Returns null if the event is malformed or has no valid stackTrace.
//
// weightField: the field name to treat as the weight value.
// ticksToNanos: multiplier to convert ticks→ns (for duration fields); 1 for raw bytes.
//
// FG-053: also captures the eventThread CP index so alloc/monitor/park events are
// attributed to the thread that actually ran them (not a hardcoded dimension name).

function readSampleEvent(buf, p3, eventEnd, fields, weightField, ticksToNanos) {
  let pp = p3;
  let startTimeTicks = 0, stackTraceIdx = -1, eventThreadIdx = -1, weight = 0;
  let ok = true;

  for (const field of fields) {
    if (pp >= eventEnd) { ok = false; break; }
    try {
      if (field.isCP) {
        const [idx, np] = readVarlong(buf, pp);
        if (field.name === 'stackTrace')   stackTraceIdx = idx;
        else if (field.name === 'eventThread') eventThreadIdx = idx;
        pp = np;
      } else {
        const [val, np] = readVarlong(buf, pp);
        if (field.name === 'startTime')     startTimeTicks = val;
        else if (field.name === weightField) weight = val;
        pp = np;
      }
    } catch (_) { ok = false; break; }
  }

  if (!ok || stackTraceIdx < 0) return null;
  return { startTimeTicks, stackTraceIdx, eventThreadIdx, weight: weight * ticksToNanos };
}

// --- Main entry point -------------------------------------------------------

export function parseJfrBytes(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const b = new ProfileBuilder();

  // Unified sample stream: all events across all chunks/threads, each carrying
  // a resolved stack, a time (ns), and sparse weight values per dimension.
  // { stack: number, time: number, thread: string,
  //   wCpu: number, wAlloc: number, wMonitor: number, wPark: number }
  const allSamples = [];

  let chunkStart = 0;
  while (chunkStart < buf.length) {
    if (buf.length - chunkStart < CHUNK_HDR_SIZE) break;
    let hdr;
    try { hdr = readChunkHeader(buf, chunkStart); } catch (_) { break; }
    const chunkEnd = chunkStart + hdr.chunkSize;
    if (hdr.chunkSize <= 0 || chunkEnd > buf.length) break;

    // Parse metadata → type schema
    let classes;
    try { classes = parseMetadata(buf, chunkStart + hdr.metaOffset); }
    catch (_) { chunkStart = chunkEnd; continue; }

    // Ticks → nanoseconds conversion factor for duration fields
    const ticksToNs = hdr.ticksPerSecond > 0 ? 1e9 / hdr.ticksPerSecond : 1;

    // Find event type IDs by name (assigned per-recording by the schema).
    // Skip any event type absent from this recording.
    let execSampleId   = -1, stackTraceClassId = -1, methodClassId = -1;
    let threadClassId  = -1;
    let allocSampleId  = -1, allocNewTlabId    = -1, allocOobTlabId  = -1;
    let monEnterSampleId = -1, monWaitSampleId = -1;
    let parkSampleId   = -1;
    for (const [id, cls] of classes) {
      switch (cls.name) {
        case 'jdk.ExecutionSample':              execSampleId       = id; break;
        case 'jdk.types.StackTrace':             stackTraceClassId  = id; break;
        case 'jdk.types.Method':                 methodClassId      = id; break;
        case 'java.lang.Thread':                 threadClassId      = id; break;
        case 'jdk.ObjectAllocationSample':       allocSampleId      = id; break;
        case 'jdk.ObjectAllocationInNewTLAB':    allocNewTlabId     = id; break;
        case 'jdk.ObjectAllocationOutsideTLAB':  allocOobTlabId     = id; break;
        case 'jdk.JavaMonitorEnter':             monEnterSampleId   = id; break;
        case 'jdk.JavaMonitorWait':              monWaitSampleId    = id; break;
        case 'jdk.ThreadPark':                   parkSampleId       = id; break;
      }
    }

    // Parse all constant-pool checkpoints
    const pools = parseCheckpoints(buf, classes, chunkStart, chunkEnd);
    const { resolveRaw, resolveString, resolveSymbol, resolveClassName } = makeResolver(pools, classes);

    function resolveThreadName(idx) {
      if (threadClassId < 0) return `thread-${idx}`;
      const t = resolveRaw(threadClassId, idx);
      if (!t) return `thread-${idx}`;
      const jn = resolveString(t.javaName);
      if (jn) return jn;
      const on = resolveString(t.osName);
      return on || `thread-${idx}`;
    }

    function resolveMethodLabel(idx) {
      if (methodClassId < 0) return null;
      const m = resolveRaw(methodClassId, idx);
      if (!m) return null;
      const c = resolveClassName(m.type);
      const n = resolveSymbol(m.name);
      const cn = c ? c.replace(/\//g, '.') : '?';
      return `${cn}.${n || '?'}`;
    }

    // Resolve a stackTrace CP index to a ProfileBuilder stack index.
    // Returns -1 if the stackTrace is null/truncated.
    function resolveStack(stackTraceIdx) {
      const strace = stackTraceClassId >= 0 ? resolveRaw(stackTraceClassId, stackTraceIdx) : null;
      if (!strace || !Array.isArray(strace.frames)) return -1;
      // frames are stored LEAF-FIRST; build root→leaf stack
      const frames = strace.frames;
      let prefix = -1;
      for (let fi = frames.length - 1; fi >= 0; fi--) {
        const frame = frames[fi];
        const label = resolveMethodLabel(frame.method);
        if (!label) continue;
        const lineNum = frame.lineNumber ?? -1;
        const fnIdx = b.internFunc(b.internString(label), -1, lineNum);
        const frIdx = b.internFrame(fnIdx, lineNum, 0);
        prefix = b.internStack(frIdx, prefix);
      }
      return prefix;
    }

    // Helper: get the fields array for an event type ID (or null if absent)
    function fields(typeId) {
      return typeId >= 0 ? (classes.get(typeId)?.fields ?? null) : null;
    }

    const execFields    = fields(execSampleId);
    const allocFields   = fields(allocSampleId);
    const allocNFields  = fields(allocNewTlabId);
    const allocOFields  = fields(allocOobTlabId);
    const monEnFields   = fields(monEnterSampleId);
    const monWaFields   = fields(monWaitSampleId);
    const parkFields    = fields(parkSampleId);

    // Scan events in the chunk
    let p = chunkStart + CHUNK_HDR_SIZE;
    while (p < chunkEnd) {
      const eventStart = p;
      const [size, p2] = readVarlong(buf, p);
      if (size === 0) break;
      const eventEnd = eventStart + size;
      if (eventEnd > chunkEnd) break;

      const [typeId, p3] = readVarlong(buf, p2);

      // --- ExecutionSample (CPU) ---
      if (execSampleId >= 0 && typeId === execSampleId && execFields) {
        let pp = p3;
        let startTimeTicks = 0, stackTraceIdx = -1, threadIdx = -1;
        let ok = true;
        for (const field of execFields) {
          if (pp >= eventEnd) { ok = false; break; }
          try {
            if (field.isCP) {
              const [idx, np] = readVarlong(buf, pp);
              if (field.name === 'stackTrace')    stackTraceIdx = idx;
              else if (field.name === 'sampledThread') threadIdx = idx;
              pp = np;
            } else {
              const [val, np] = readVarlong(buf, pp);
              if (field.name === 'startTime') startTimeTicks = val;
              pp = np;
            }
          } catch (_) { ok = false; break; }
        }
        if (ok && stackTraceIdx >= 0) {
          const timeNanos = hdr.startTimeNanos +
            (startTimeTicks - hdr.startTicks) * ticksToNs;
          const stackIdx = resolveStack(stackTraceIdx);
          const tname = resolveThreadName(threadIdx);
          allSamples.push({ stack: stackIdx, time: timeNanos, thread: tname,
            wCpu: 1, wAlloc: 0, wMonitor: 0, wPark: 0 });
        }
      }

      // --- ObjectAllocationSample (weight field = "weight", bytes) ---
      // FG-053: resolve eventThread CP index → real thread name (same as sampledThread for CPU).
      else if (allocSampleId >= 0 && typeId === allocSampleId && allocFields) {
        const ev = readSampleEvent(buf, p3, eventEnd, allocFields, 'weight', 1);
        if (ev) {
          const timeNanos = hdr.startTimeNanos + (ev.startTimeTicks - hdr.startTicks) * ticksToNs;
          const tname = resolveThreadName(ev.eventThreadIdx);
          allSamples.push({ stack: resolveStack(ev.stackTraceIdx), time: timeNanos,
            thread: tname, wCpu: 0, wAlloc: ev.weight, wMonitor: 0, wPark: 0 });
        }
      }

      // --- ObjectAllocationInNewTLAB (weight field = "allocationSize", bytes) ---
      else if (allocNewTlabId >= 0 && typeId === allocNewTlabId && allocNFields) {
        const ev = readSampleEvent(buf, p3, eventEnd, allocNFields, 'allocationSize', 1);
        if (ev) {
          const timeNanos = hdr.startTimeNanos + (ev.startTimeTicks - hdr.startTicks) * ticksToNs;
          const tname = resolveThreadName(ev.eventThreadIdx);
          allSamples.push({ stack: resolveStack(ev.stackTraceIdx), time: timeNanos,
            thread: tname, wCpu: 0, wAlloc: ev.weight, wMonitor: 0, wPark: 0 });
        }
      }

      // --- ObjectAllocationOutsideTLAB (weight field = "allocationSize", bytes) ---
      else if (allocOobTlabId >= 0 && typeId === allocOobTlabId && allocOFields) {
        const ev = readSampleEvent(buf, p3, eventEnd, allocOFields, 'allocationSize', 1);
        if (ev) {
          const timeNanos = hdr.startTimeNanos + (ev.startTimeTicks - hdr.startTicks) * ticksToNs;
          const tname = resolveThreadName(ev.eventThreadIdx);
          allSamples.push({ stack: resolveStack(ev.stackTraceIdx), time: timeNanos,
            thread: tname, wCpu: 0, wAlloc: ev.weight, wMonitor: 0, wPark: 0 });
        }
      }

      // --- JavaMonitorEnter (weight field = "duration", ticks→ns) ---
      else if (monEnterSampleId >= 0 && typeId === monEnterSampleId && monEnFields) {
        const ev = readSampleEvent(buf, p3, eventEnd, monEnFields, 'duration', ticksToNs);
        if (ev) {
          const timeNanos = hdr.startTimeNanos + (ev.startTimeTicks - hdr.startTicks) * ticksToNs;
          const tname = resolveThreadName(ev.eventThreadIdx);
          allSamples.push({ stack: resolveStack(ev.stackTraceIdx), time: timeNanos,
            thread: tname, wCpu: 0, wAlloc: 0, wMonitor: ev.weight, wPark: 0 });
        }
      }

      // --- JavaMonitorWait (weight field = "duration", ticks→ns) ---
      else if (monWaitSampleId >= 0 && typeId === monWaitSampleId && monWaFields) {
        const ev = readSampleEvent(buf, p3, eventEnd, monWaFields, 'duration', ticksToNs);
        if (ev) {
          const timeNanos = hdr.startTimeNanos + (ev.startTimeTicks - hdr.startTicks) * ticksToNs;
          const tname = resolveThreadName(ev.eventThreadIdx);
          allSamples.push({ stack: resolveStack(ev.stackTraceIdx), time: timeNanos,
            thread: tname, wCpu: 0, wAlloc: 0, wMonitor: ev.weight, wPark: 0 });
        }
      }

      // --- ThreadPark (weight field = "duration", ticks→ns) ---
      else if (parkSampleId >= 0 && typeId === parkSampleId && parkFields) {
        const ev = readSampleEvent(buf, p3, eventEnd, parkFields, 'duration', ticksToNs);
        if (ev) {
          const timeNanos = hdr.startTimeNanos + (ev.startTimeTicks - hdr.startTicks) * ticksToNs;
          const tname = resolveThreadName(ev.eventThreadIdx);
          allSamples.push({ stack: resolveStack(ev.stackTraceIdx), time: timeNanos,
            thread: tname, wCpu: 0, wAlloc: 0, wMonitor: 0, wPark: ev.weight });
        }
      }

      p = eventEnd;
    }

    chunkStart = chunkEnd;
  }

  if (allSamples.length === 0) {
    return b.finish([], {
      hasTiming: true, weightTypes: ['samples'], timeUnit: 'nanoseconds', isDiff: false,
    });
  }

  // Sort all samples by time (monotonic order across all threads/types)
  allSamples.sort((a, c) => a.time - c.time);

  // Determine which weight dimensions are actually present
  const hasCpu     = allSamples.some(s => s.wCpu     > 0);
  const hasAlloc   = allSamples.some(s => s.wAlloc   > 0);
  const hasMonitor = allSamples.some(s => s.wMonitor > 0);
  const hasPark    = allSamples.some(s => s.wPark    > 0);

  // Build weightTypes list: CPU first when present (keeps FG-031 behavior unchanged)
  const weightTypes = [];
  if (hasCpu)     weightTypes.push('samples');
  if (hasAlloc)   weightTypes.push('alloc_bytes');
  if (hasMonitor) weightTypes.push('monitor_nanos');
  if (hasPark)    weightTypes.push('park_nanos');
  if (weightTypes.length === 0) weightTypes.push('samples');

  // FG-053: Group samples by real thread name → N Thread objects, one per distinct thread.
  // Each thread carries sparse multi-value columns (0 for dimensions it doesn't contribute).
  // The "all threads" merged view (produced by mergedThread() in callnode.js) reproduces
  // FG-052's unified stream — alloc/wait/park dimensions are reachable in the merged view
  // and in any per-thread view for the thread that produced them.
  const threadNames = [...new Set(allSamples.map(s => s.thread))];

  const threads = threadNames.map(tname => {
    const ts = allSamples.filter(s => s.thread === tname);
    const wbt = {};
    if (hasCpu)     wbt['samples']       = ts.map(s => s.wCpu);
    if (hasAlloc)   wbt['alloc_bytes']   = ts.map(s => s.wAlloc);
    if (hasMonitor) wbt['monitor_nanos'] = ts.map(s => s.wMonitor);
    if (hasPark)    wbt['park_nanos']    = ts.map(s => s.wPark);
    // Pad any missing weight types with 0-arrays (model invariant: all wt columns present)
    for (const wt of weightTypes) { if (!wbt[wt]) wbt[wt] = ts.map(() => 0); }
    return {
      name: tname,
      samples: { stack: ts.map(s => s.stack), weightsByType: wbt, time: ts.map(s => s.time) },
    };
  });

  return b.finish(threads, {
    hasTiming: true, weightTypes, timeUnit: 'nanoseconds', isDiff: false,
  });
}
