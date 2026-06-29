// Scene → Gecko "raw" profile JSON (meta.version 5, the format emitted by Firefox and samply).
//
// Each thread has:
//   stringTable: string[]
//   funcTable:   {schema: {name:0, fileName:1, lineNumber:2}, data: [[...], ...]}
//   frameTable:  {schema: {location:0, relevantForJS:1, line:2, category:3}, data: ...}
//   stackTable:  {schema: {frame:0, prefix:1}, data: [[frameIdx, parentStackIdx|null], ...]}
//   samples:     {schema: {stack:0, time:1, responsiveness:2}, data: [[stackIdx, ms, 0], ...]}
//
// The Scene has no file/line info, so fileName is '' and line is -1 throughout.
// stackTable is a prefix tree: each entry is (frame, parent_stack_index|null).
// We build one func per unique frame name (matching what parse-gecko.js expects).

export function emitGecko(scene) {
  const strs = [];
  const strIdx = new Map();
  const sidx = (s) => {
    let i = strIdx.get(s);
    if (i === undefined) { i = strs.length; strs.push(s); strIdx.set(s, i); }
    return i;
  };

  // funcTable: one func per unique frame name
  const funcData = [];  // [[nameIdx, fileNameIdx, lineNumber], ...]
  const funcByName = new Map();
  const internFunc = (name) => {
    let f = funcByName.get(name);
    if (f === undefined) {
      f = funcData.length;
      funcData.push([sidx(name), sidx(''), -1]);
      funcByName.set(name, f);
    }
    return f;
  };

  // frameTable: one frame per unique func (no line/col variation in Scene)
  const frameData = [];  // [[funcIdx, false, -1, 0], ...]
  const frameByFunc = new Map();
  const internFrame = (funcIdx) => {
    let fr = frameByFunc.get(funcIdx);
    if (fr === undefined) {
      fr = frameData.length;
      frameData.push([funcIdx, false, -1, 0]);  // [location_as_func_idx, relevantForJS, line, category]
      frameByFunc.set(funcIdx, fr);
    }
    return fr;
  };

  // stackTable: prefix tree. Key = "frameIdx:prefixIdx" (prefixIdx=-1 means root/null)
  const stackData = [];  // [[frameIdx, parentStackIdx|null], ...]
  const stackByKey = new Map();
  const internStack = (frameIdx, prefixIdx) => {
    const key = frameIdx + ':' + prefixIdx;
    let si = stackByKey.get(key);
    if (si === undefined) {
      si = stackData.length;
      stackData.push([frameIdx, prefixIdx === -1 ? null : prefixIdx]);
      stackByKey.set(key, si);
    }
    return si;
  };

  // Build per-sample stack indices
  const sampleData = [];  // [[stackIdx, timeMs, weight], ...]
  for (const s of scene.samples) {
    // Build the prefix chain from root (stack[0]) to leaf (stack[last])
    let prefix = -1;
    for (const fname of s.stack) {
      const fi = internFunc(fname);
      const fr = internFrame(fi);
      prefix = internStack(fr, prefix);
    }
    const timeMs = s.time != null ? s.time : 0;
    const weight = s.weight != null ? s.weight : 1;
    sampleData.push([prefix, timeMs, weight]);
  }

  const thread = {
    name: 'GeckoMain',
    processType: 'default',
    tid: 1,
    pid: 1,
    registerTime: 0,
    unregisterTime: null,
    stringTable: strs,
    funcTable: {
      schema: { name: 0, fileName: 1, lineNumber: 2 },
      data: funcData,
    },
    frameTable: {
      // location column in frameTable: raw format stores a string-table index to the
      // function label. We store the func index into funcTable, but parse-gecko.js's
      // raw-frame path reads frameTable.location as a stringTable index. To keep the
      // round-trip consistent, store the name string-table index directly as 'location'.
      // (The func column is absent in raw format — parse-gecko detects this.)
      schema: { location: 0, relevantForJS: 1, line: 2, category: 3 },
      data: frameData.map((fr) => [funcData[fr[0]][0], fr[1], fr[2], fr[3]]),
    },
    stackTable: {
      schema: { frame: 0, prefix: 1 },
      data: stackData,
    },
    samples: {
      schema: { stack: 0, time: 1, weight: 2 },
      data: sampleData,
    },
  };

  const profile = {
    meta: {
      version: 5,
      interval: 1,
      stackwalk: 0,
      startTime: 0,
      shutdownTime: null,
      processType: 0,
      product: 'spicypath',
    },
    threads: [thread],
  };

  return JSON.stringify(profile);
}
