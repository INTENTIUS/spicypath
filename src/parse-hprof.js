// HPROF binary heap-dump parser → HeapModel (object graph). Pure ES module, no node: imports.
// Implements FG-058 (object graph: objects, references, GC roots, shallow sizes, per-class histogram)
// + FG-059 (retainedOf/dominatorParentOf, computed lazily via src/heap-dominators.js).
//
// Format: big-endian, idSize=8 (JDK 25 default).
//   Header: NUL-terminated version string, u4 identifierSize, u8 timestamp.
//   Records: u1 tag, u4 timeOffset, u4 length, body[length].
//     0x01 STRING_IN_UTF8: id stringId, utf8[length-idSize]
//     0x02 LOAD_CLASS: u4 classSerial, id classObjId, u4 stackSerial, id classNameStringId
//     0x0C HEAP_DUMP / 0x1C HEAP_DUMP_SEGMENT: sub-record stream
//     0x2C HEAP_DUMP_END: marks end of heap data
//   Heap-dump sub-records:
//     GC roots (0x01–0x08): collect object id; skip remaining fields per sub-tag.
//     0x20 CLASS_DUMP: classObjId, superId, sizes, static fields, instance-field types (in order).
//     0x21 INSTANCE_DUMP: objId, classObjId, nBytes, fieldBytes.
//     0x22 OBJECT_ARRAY_DUMP: objId, nElems, arrayClassId, elem ids.
//     0x23 PRIMITIVE_ARRAY_DUMP: objId, nElems, elemType, data.
//
// Two-pass strategy:
//   Pass 1 (top-level record loop): collect STRING, LOAD_CLASS, CLASS_DUMP sub-records.
//   Pass 2 (heap-dump sub-records again): collect INSTANCE, OBJECT_ARRAY, PRIMITIVE_ARRAY, GC roots.
// This ensures class/superclass chains are fully known before decoding instance field bytes.
//
// Instance refs: walk own class's instance-field type list → then superclass → ... → Object.
// For each field of type 2 (object ref), read an id; else skip by type size.
//
// Id mapping: native 8-byte ids → dense 0..N-1 index via a Map. Null/dangling refs dropped.
//
// Class name conventions: instances → LOAD_CLASS name with '/' replaced by '.';
// primitive arrays → 'byte[]', 'int[]', etc.; object arrays → elementClass + '[]'.
//
// Shallow sizes: instances → nBytes (field bytes, close to instanceSize); object arrays → nElems*idSize;
// primitive arrays → nElems * elemTypeSize. (SLACK in the test covers any header constant differences.)

import { computeHeapDominators } from './heap-dominators.js'; // FG-059: dominators + retained size

// Basic type code sizes (bytes). Type code 2 = object ref (idSize, handled separately).
const TYPE_SIZE = { 4: 1, 5: 2, 6: 4, 7: 8, 8: 1, 9: 2, 10: 4, 11: 8 };

// Primitive array element type code → human name suffix (the part before '[]').
const PRIM_ARRAY_NAME = { 4: 'boolean', 5: 'char', 6: 'float', 7: 'double', 8: 'byte', 9: 'short', 10: 'int', 11: 'long' };

// Read a big-endian unsigned 64-bit id as a JS Number (safe for object pointer magnitudes).
// hi and lo are both treated as unsigned 32-bit halves.
function readId(dv, pos, idSize) {
  if (idSize === 4) return dv.getUint32(pos, false);
  const hi = dv.getUint32(pos, false);
  const lo = dv.getUint32(pos + 4, false);
  return hi * 4294967296 + lo;
}

export function parseHprof(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Parse header: NUL-terminated version string, then u4 idSize, u8 timestamp.
  let hdrEnd = 0;
  while (hdrEnd < bytes.length && bytes[hdrEnd] !== 0) hdrEnd++;
  const idSize = dv.getUint32(hdrEnd + 1, false);
  // Record stream starts after: version\0 (hdrEnd+1 bytes) + u4 idSize + u8 timestamp
  const recordStart = hdrEnd + 1 + 4 + 8;

  // ── Collect heap-dump segment offsets (and end of each) for pass 2 ──────────────────────────
  // Also collect STRING and LOAD_CLASS in pass 1 (they are top-level records).

  // stringId (native id) → string value
  const strings = new Map();
  // classObjId (native id) → nameStringId (native id); populated by LOAD_CLASS
  const classNameIds = new Map();
  // classObjId (native id) → { superId, instanceFieldTypes: number[] }
  // instanceFieldTypes: ordered list of type codes for the class's OWN instance fields
  const classMeta = new Map();
  // Native ids referenced by object-typed static fields — GC roots (mapped to indices in pass 2).
  const staticRootNativeIds = [];

  // Heap-dump body ranges (start offset, end offset) in the bytes array
  const heapSegments = []; // [{start, end}]

  // ── Pass 1: top-level records ────────────────────────────────────────────────────────────────
  {
    let off = recordStart;
    while (off + 9 <= bytes.length) {
      const tag = bytes[off];
      const len = dv.getUint32(off + 5, false); // skip u4 timeOffset at off+1
      const bodyStart = off + 9;
      const bodyEnd   = bodyStart + len;

      if (tag === 0x01) {
        // STRING_IN_UTF8: id stringId, then utf8 bytes
        const sId = readId(dv, bodyStart, idSize);
        const str = new TextDecoder().decode(bytes.subarray(bodyStart + idSize, bodyEnd));
        strings.set(sId, str);
      } else if (tag === 0x02) {
        // LOAD_CLASS: u4 classSerial, id classObjId, u4 stackSerial, id classNameStringId
        const classObjId     = readId(dv, bodyStart + 4, idSize);
        const classNameStrId = readId(dv, bodyStart + 4 + idSize + 4, idSize);
        classNameIds.set(classObjId, classNameStrId);
      } else if (tag === 0x0c || tag === 0x1c) {
        // HEAP_DUMP or HEAP_DUMP_SEGMENT — scan sub-records for CLASS_DUMP in pass 1
        // Also record the segment range for pass 2.
        heapSegments.push({ start: bodyStart, end: bodyEnd });

        // Scan sub-records for CLASS_DUMP (0x20) only.
        let p = bodyStart;
        while (p < bodyEnd) {
          const subTag = bytes[p]; p++;
          if (subTag === 0x20) {
            // CLASS_DUMP — parse fully
            const classObjId = readId(dv, p, idSize); p += idSize;
            p += 4; // stack serial
            const superId = readId(dv, p, idSize); p += idSize;
            p += idSize * 5; // loader, signer, protDomain, r1, r2 (5 more ids) — skip
            const instanceSize = dv.getUint32(p, false); p += 4;
            // constant pool: u2 cpCount, then cpCount entries of [u2 cpIndex, u1 type, value]
            const cpCount = dv.getUint16(p, false); p += 2;
            for (let i = 0; i < cpCount; i++) {
              p += 2; // constant pool index (u2)
              const cpType = bytes[p]; p++;
              if (cpType === 2) p += idSize;
              else p += (TYPE_SIZE[cpType] ?? 4);
            }
            // static fields: u2 nStatic, then [id nameStrId, u1 type, value]. An object-typed
            // static field is a GC root (the class holds the referenced object alive) — collect
            // its target so much of a real heap's object graph (held by statics) is reachable.
            const nStatic = dv.getUint16(p, false); p += 2;
            for (let i = 0; i < nStatic; i++) {
              p += idSize; // nameStringId
              const fType = bytes[p]; p++;
              if (fType === 2) { const t = readId(dv, p, idSize); if (t !== 0) staticRootNativeIds.push(t); p += idSize; }
              else p += (TYPE_SIZE[fType] ?? 4);
            }
            // instance fields: u2 nInstance, then [id nameStrId, u1 type]
            const nInstance = dv.getUint16(p, false); p += 2;
            const instanceFieldTypes = [];
            for (let i = 0; i < nInstance; i++) {
              p += idSize; // nameStringId (we don't need the name, just the type)
              const fType = bytes[p]; p++;
              instanceFieldTypes.push(fType);
            }
            classMeta.set(classObjId, { superId, instanceSize, instanceFieldTypes });
          } else {
            // Skip all other sub-records. p is already past the subTag byte (incremented above).
            p = skipSubRecordBody(bytes, dv, subTag, p, idSize);
          }
        }
      }
      // All other top-level tags (STACK_TRACE 0x05, STACK_FRAME 0x04, etc.): skip by length.

      off = bodyEnd;
    }
  }

  // ── Pass 2: collect live objects and GC roots from heap-dump sub-records ─────────────────────
  // We need two sub-passes through the heap segments:
  //   Sub-pass 2a: enumerate all live object ids to build the id→denseIndex map.
  //   Sub-pass 2b: decode instances/arrays/roots using the index map.

  // Sub-pass 2a: collect all object ids from INSTANCE, OBJECT_ARRAY, PRIMITIVE_ARRAY sub-records.
  const nativeIds = []; // will become the dense index mapping: nativeIds[denseIdx] = nativeId

  for (const seg of heapSegments) {
    let p = seg.start;
    while (p < seg.end) {
      const subTag = bytes[p]; p++;
      if (subTag === 0x21) {
        // INSTANCE_DUMP
        const objId = readId(dv, p, idSize);
        nativeIds.push(objId);
        // skip: stack(4), classObjId(idSize), nBytes(4), fieldBytes(nBytes)
        p += idSize; // objId already accounted for above after save
        p += 4; // stack serial
        p += idSize; // classObjId
        const nBytes = dv.getUint32(p, false); p += 4;
        p += nBytes;
      } else if (subTag === 0x22) {
        // OBJECT_ARRAY_DUMP
        const objId = readId(dv, p, idSize);
        nativeIds.push(objId);
        p += idSize;
        p += 4; // stack serial
        const nElems = dv.getUint32(p, false); p += 4;
        p += idSize; // arrayClassId
        p += nElems * idSize; // element ids
      } else if (subTag === 0x23) {
        // PRIMITIVE_ARRAY_DUMP
        const objId = readId(dv, p, idSize);
        nativeIds.push(objId);
        p += idSize;
        p += 4; // stack serial
        const nElems = dv.getUint32(p, false); p += 4;
        const elemType = bytes[p]; p++;
        const elemSize = TYPE_SIZE[elemType] ?? 1;
        p += nElems * elemSize;
      } else {
        // GC roots and CLASS_DUMP — skip body
        p = skipSubRecordBody(bytes, dv, subTag, p, idSize);
      }
    }
  }

  // Build id → dense index map
  const idToIdx = new Map();
  for (let i = 0; i < nativeIds.length; i++) {
    idToIdx.set(nativeIds[i], i);
  }
  const N = nativeIds.length;

  // Storage arrays (parallel, indexed by dense id)
  const shallows    = new Int32Array(N);       // shallow size per object (fits in 32-bit signed for all practical sizes)
  const classOfObj  = new Int32Array(N).fill(-1); // dense class id → actually we use a class name string index
  const classIdxOf  = new Int32Array(N).fill(-1); // index into classNames array for each object
  const classNames  = [];                       // classNames[i] = human name string
  const classNativeToIdx = new Map();           // classObjId (native) → index in classNames

  // Build class name lookup
  function getOrMakeClassIdx(classObjId) {
    let ci = classNativeToIdx.get(classObjId);
    if (ci !== undefined) return ci;
    ci = classNames.length;
    const strId = classNameIds.get(classObjId);
    let name = strId !== undefined ? (strings.get(strId) ?? `class@${classObjId}`) : `class@${classObjId}`;
    // Normalize: '/' → '.'
    name = name.replace(/\//g, '.');
    classNames.push(name);
    classNativeToIdx.set(classObjId, ci);
    return ci;
  }

  // For primitive arrays the class object is an array class; we override the name below.
  // For object arrays likewise. We track per-object special names via classIdxOf.

  // GC roots: dense indices (deduplicated)
  const rootSet = new Set();

  // refs: per-object list of outgoing dense indices. We'll build this compactly.
  // Use a flat array approach: refsFlat is a concatenation; refsOffset[i] = start in refsFlat, refsLen[i] = count.
  // But since objects can have varying ref counts, build per-object ref lists first, then flatten.
  const refsPerObj = new Array(N); // refsPerObj[i] = number[] (will be set during sub-pass 2b)

  // Sub-pass 2b: decode instances, arrays, and GC roots.
  for (const seg of heapSegments) {
    let p = seg.start;
    while (p < seg.end) {
      const subTag = bytes[p]; p++;

      if (subTag === 0x21) {
        // INSTANCE_DUMP: id objId, u4 stack, id classObjId, u4 nBytes, fieldBytes[nBytes]
        const nativeObjId = readId(dv, p, idSize); p += idSize;
        p += 4; // stack serial
        const classObjId = readId(dv, p, idSize); p += idSize;
        const nBytes = dv.getUint32(p, false); p += 4;
        const fieldStart = p;
        p += nBytes;

        const idx = idToIdx.get(nativeObjId);
        if (idx === undefined) continue; // should not happen

        shallows[idx] = nBytes;
        const ci = getOrMakeClassIdx(classObjId);
        classIdxOf[idx] = ci;

        // Decode instance fields to extract object refs.
        // Walk the superclass chain: own class first, then parent, ... until null/unknown.
        const refs = [];
        let fp = fieldStart;
        let cid = classObjId;
        while (cid !== 0 && fp < fieldStart + nBytes) {
          const meta = classMeta.get(cid);
          if (!meta) break;
          for (const fType of meta.instanceFieldTypes) {
            if (fType === 2) {
              // object reference
              if (fp + idSize > fieldStart + nBytes) break;
              const refNative = readId(dv, fp, idSize); fp += idSize;
              if (refNative !== 0) {
                const refIdx = idToIdx.get(refNative);
                if (refIdx !== undefined) refs.push(refIdx);
                // else: dangling (class object or not in live set) — drop
              }
            } else {
              const sz = TYPE_SIZE[fType] ?? 4;
              fp += sz;
            }
          }
          cid = meta.superId;
        }
        refsPerObj[idx] = refs;

      } else if (subTag === 0x22) {
        // OBJECT_ARRAY_DUMP: id objId, u4 stack, u4 nElems, id arrayClassId, elems[nElems*idSize]
        const nativeObjId = readId(dv, p, idSize); p += idSize;
        p += 4; // stack serial
        const nElems = dv.getUint32(p, false); p += 4;
        const arrayClassId = readId(dv, p, idSize); p += idSize;

        const idx = idToIdx.get(nativeObjId);
        if (idx === undefined) { p += nElems * idSize; continue; }

        shallows[idx] = nElems * idSize;

        // Determine element class name for the array type name.
        // arrayClassId points to the array class (e.g., [LHprofWorkload$ExclusiveOwner;)
        // The LOAD_CLASS name for an array class looks like '[LFoo;' or '[B' etc.
        // We want to derive the element class name + '[]'.
        let arrClassName;
        const arrClassStrId = classNameIds.get(arrayClassId);
        if (arrClassStrId !== undefined) {
          const rawName = strings.get(arrClassStrId) ?? '';
          // rawName may be like '[LHprofWorkload$ExclusiveOwner;' → strip '[L' and ';'
          if (rawName.startsWith('[L') && rawName.endsWith(';')) {
            let elem = rawName.slice(2, -1).replace(/\//g, '.');
            // strip outer package if needed — keep as-is per spec (use full qualified name)
            arrClassName = elem + '[]';
          } else if (rawName.startsWith('[')) {
            // multi-dim or other: use raw name
            arrClassName = rawName;
          } else {
            arrClassName = rawName + '[]';
          }
        } else {
          arrClassName = 'Object[]';
        }

        // Ensure class name exists in the classNames table.
        let ci = classNativeToIdx.get(arrayClassId);
        if (ci === undefined) {
          ci = classNames.length;
          classNames.push(arrClassName);
          classNativeToIdx.set(arrayClassId, ci);
        } else {
          // Override whatever the LOAD_CLASS put there with the proper '[]' form
          classNames[ci] = arrClassName;
        }
        classIdxOf[idx] = ci;

        // Collect element refs
        const refs = [];
        for (let i = 0; i < nElems; i++) {
          const refNative = readId(dv, p, idSize); p += idSize;
          if (refNative !== 0) {
            const refIdx = idToIdx.get(refNative);
            if (refIdx !== undefined) refs.push(refIdx);
          }
        }
        refsPerObj[idx] = refs;

      } else if (subTag === 0x23) {
        // PRIMITIVE_ARRAY_DUMP: id objId, u4 stack, u4 nElems, u1 elemType, data[nElems*size]
        const nativeObjId = readId(dv, p, idSize); p += idSize;
        p += 4; // stack serial
        const nElems = dv.getUint32(p, false); p += 4;
        const elemType = bytes[p]; p++;
        const elemSize = TYPE_SIZE[elemType] ?? 1;

        const idx = idToIdx.get(nativeObjId);
        if (idx === undefined) { p += nElems * elemSize; continue; }

        shallows[idx] = nElems * elemSize;

        // Primitive array class name: 'byte[]', 'int[]', etc.
        const primName = (PRIM_ARRAY_NAME[elemType] ?? 'byte') + '[]';
        // We don't have a reliable classObjId here; store by a synthetic key.
        // Use element type code as the class identity key for primitive arrays.
        // We'll map them all to synthetic classNativeToIdx entries with negative keys.
        const syntheticKey = -(elemType + 1); // -5..-12, won't clash with real ids
        let ci = classNativeToIdx.get(syntheticKey);
        if (ci === undefined) {
          ci = classNames.length;
          classNames.push(primName);
          classNativeToIdx.set(syntheticKey, ci);
        }
        classIdxOf[idx] = ci;

        refsPerObj[idx] = []; // no object refs in a primitive array
        p += nElems * elemSize;

      } else if (subTag >= 0x01 && subTag <= 0x08) {
        // GC root sub-records — collect the object id, skip remaining fields.
        const nativeObjId = readId(dv, p, idSize);
        const rootIdx = idToIdx.get(nativeObjId);
        if (rootIdx !== undefined) rootSet.add(rootIdx);
        // Skip body (already read idSize for the first id; skip the rest)
        p = skipSubRecordBody(bytes, dv, subTag, p, idSize);

      } else {
        // Skip CLASS_DUMP and any unknown sub-records
        p = skipSubRecordBody(bytes, dv, subTag, p, idSize);
      }
    }
  }

  // Compute totalShallow
  let totalShallow = 0;
  for (let i = 0; i < N; i++) totalShallow += shallows[i];

  // Object-typed static fields are GC roots too — fold their (now-mappable) targets in.
  for (const nativeId of staticRootNativeIds) {
    const idx = idToIdx.get(nativeId);
    if (idx !== undefined) rootSet.add(idx);
  }

  // Deduplicated roots array
  const roots = [...rootSet];

  // Fill any objects that had no refs decoded (shouldn't happen, but be safe)
  for (let i = 0; i < N; i++) {
    if (refsPerObj[i] === undefined) refsPerObj[i] = [];
  }

  // ── Build byClass grouping ───────────────────────────────────────────────────────────────────
  // Group objects by classIdx → { name, count, shallow }
  const classCounts  = new Int32Array(classNames.length);
  const classShallow = new Float64Array(classNames.length); // use float64 to avoid 32-bit overflow for large heaps

  for (let i = 0; i < N; i++) {
    const ci = classIdxOf[i];
    if (ci >= 0) {
      classCounts[ci]++;
      classShallow[ci] += shallows[i];
    }
  }

  // ── HeapModel ────────────────────────────────────────────────────────────────────────────────
  const heap = {
    objectCount: N,
    totalShallow,
    roots,

    byClass() {
      const result = [];
      for (let ci = 0; ci < classNames.length; ci++) {
        if (classCounts[ci] > 0) {
          result.push({ name: classNames[ci], count: classCounts[ci], shallow: classShallow[ci] });
        }
      }
      return result;
    },

    objectsOfClass(nameSuffix) {
      const out = [];
      for (let i = 0; i < N; i++) {
        const ci = classIdxOf[i];
        if (ci >= 0 && classNames[ci].endsWith(nameSuffix)) out.push(i);
      }
      return out;
    },

    shallowOf(id) {
      return shallows[id] ?? 0;
    },

    refsOf(id) {
      return refsPerObj[id] ?? [];
    },

    className(id) {
      const ci = classIdxOf[id];
      return ci >= 0 ? classNames[ci] : '';
    },

    // FG-059: dominators + retained size, computed once on first use (a histogram-only caller
    // never pays for it). `_dom` memoizes { idom, retained, superRoot }.
    _dom: null,
    _ensureDom() {
      if (!this._dom) this._dom = computeHeapDominators(N, roots, (id) => refsPerObj[id] ?? [], (id) => shallows[id] ?? 0);
      return this._dom;
    },
    retainedOf(id) {
      return this._ensureDom().retained[id] ?? 0;
    },
    dominatorParentOf(id) {
      const d = this._ensureDom();
      const p = d.idom[id];
      return p === d.superRoot ? -1 : p;
    },
  };

  return {
    capabilities: { kind: 'heap', weightTypes: [], hasTiming: false, isDiff: false },
    heap,
  };
}

// ── Skip helpers for heap-dump sub-records ────────────────────────────────────────────────────
//
// skipSubRecordBody: given a subTag and position p AFTER the subTag byte was consumed,
// return the position after this sub-record's body. Does NOT read the subTag again.
//
// GC root sub-records (0x01–0x08): first field is always an object id.
// Remaining fixed fields per sub-tag:
//   0x01 JNI_GLOBAL:      id(obj), id(refId)                   → 2 ids
//   0x02 JNI_LOCAL:       id(obj), u4(threadSerial), u4(frame) → 1 id + 8 bytes
//   0x03 JAVA_FRAME:      id(obj), u4(threadSerial), u4(frame) → 1 id + 8 bytes
//   0x04 NATIVE_STACK:    id(obj), u4(threadSerial)            → 1 id + 4 bytes
//   0x05 STICKY_CLASS:    id(obj)                              → 1 id
//   0x06 THREAD_BLOCK:    id(obj), u4(threadSerial)            → 1 id + 4 bytes
//   0x07 MONITOR_USED:    id(obj)                              → 1 id
//   0x08 THREAD_OBJECT:   id(obj), u4(threadSerial), u4(stackSerial) → 1 id + 8 bytes

function skipSubRecordBody(bytes, dv, subTag, p, idSize) {
  if (subTag === 0x01) { return p + idSize * 2; }           // JNI_GLOBAL: obj id + ref id
  if (subTag === 0x02) { return p + idSize + 8; }           // JNI_LOCAL: obj id + 2 u4
  if (subTag === 0x03) { return p + idSize + 8; }           // JAVA_FRAME: obj id + 2 u4
  if (subTag === 0x04) { return p + idSize + 4; }           // NATIVE_STACK: obj id + 1 u4
  if (subTag === 0x05) { return p + idSize; }               // STICKY_CLASS: obj id
  if (subTag === 0x06) { return p + idSize + 4; }           // THREAD_BLOCK: obj id + 1 u4
  if (subTag === 0x07) { return p + idSize; }               // MONITOR_USED: obj id
  if (subTag === 0x08) { return p + idSize + 8; }           // THREAD_OBJECT: obj id + 2 u4

  if (subTag === 0x20) {
    // CLASS_DUMP: id classObjId, u4 stack, 7 ids (super, loader, signer, protDomain, r1, r2 — wait, spec says 6 more), u4 instanceSize, ...
    // Actual: id classObjId, u4 stack, id super, id loader, id signer, id protDomain, id r1, id r2, u4 instanceSize
    // = idSize + 4 + 6*idSize + 4 = 7*idSize + 8 before the CP entries
    let q = p + idSize + 4 + 6 * idSize + 4; // past classObjId+stack+6 more ids+instanceSize
    // Wait, the layout again per spec:
    // id classObjId (already at p), u4 stack, id superId, id loader, id signer, id protDomain, id r1, id r2, u4 instanceSize
    // = 1 id + 4 + 6 ids + 4 = 7 ids + 8 bytes. Since p is already AFTER the subTag but BEFORE classObjId:
    // actually in the first pass we did: p = pos AFTER subTag, so we do idSize (classObjId) + 4 (stack) + 6*idSize (others) + 4 (instanceSize)
    // = 7*idSize + 8 total before cpCount
    q = p + 7 * idSize + 8;
    const cpCount = dv.getUint16(q, false); q += 2;
    for (let i = 0; i < cpCount; i++) {
      q += 2; // u2 cp index
      const cpType = bytes[q]; q++;
      q += cpType === 2 ? idSize : (TYPE_SIZE[cpType] ?? 4);
    }
    const nStatic = dv.getUint16(q, false); q += 2;
    for (let i = 0; i < nStatic; i++) {
      q += idSize; // name string id
      const fType = bytes[q]; q++;
      q += fType === 2 ? idSize : (TYPE_SIZE[fType] ?? 4);
    }
    const nInstance = dv.getUint16(q, false); q += 2;
    q += nInstance * (idSize + 1); // each: id nameStrId + u1 type
    return q;
  }

  if (subTag === 0x21) {
    // INSTANCE_DUMP: id objId, u4 stack, id classObjId, u4 nBytes, fieldBytes[nBytes]
    const nBytes = dv.getUint32(p + idSize + 4 + idSize, false);
    return p + idSize + 4 + idSize + 4 + nBytes;
  }

  if (subTag === 0x22) {
    // OBJECT_ARRAY_DUMP: id objId, u4 stack, u4 nElems, id arrayClassId, elems[nElems*idSize]
    const nElems = dv.getUint32(p + idSize + 4, false);
    return p + idSize + 4 + 4 + idSize + nElems * idSize;
  }

  if (subTag === 0x23) {
    // PRIMITIVE_ARRAY_DUMP: id objId, u4 stack, u4 nElems, u1 elemType, data
    const nElems = dv.getUint32(p + idSize + 4, false);
    const elemType = bytes[p + idSize + 4 + 4];
    const elemSize = TYPE_SIZE[elemType] ?? 1;
    return p + idSize + 4 + 4 + 1 + nElems * elemSize;
  }

  // Unknown sub-tag — we cannot safely skip. Return p (caller will loop forever if body is non-zero).
  // In practice JDK 25 only emits the known sub-tags above.
  return p;
}

