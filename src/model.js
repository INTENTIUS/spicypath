// Canonical model runtime (ProfileBuilder + checkInvariants) as plain JS so BOTH Node
// and the browser use one implementation, no build step. Types live in model.ts.

export class ProfileBuilder {
  constructor() {
    this.stringTable = [];
    this.funcTable = { name: [], file: [], line: [] };
    this.frameTable = { func: [], line: [], inlineDepth: [] };
    this.stackTable = { frame: [], prefix: [] };
    this.stringMap = new Map();
    this.funcMap = new Map();
    this.frameMap = new Map();
    this.stackMap = new Map();
  }
  internString(s) {
    let i = this.stringMap.get(s);
    if (i === undefined) { i = this.stringTable.length; this.stringTable.push(s); this.stringMap.set(s, i); }
    return i;
  }
  internFunc(name, file, line) {
    const key = name + '#' + file;
    let i = this.funcMap.get(key);
    if (i === undefined) { i = this.funcTable.name.length; this.funcTable.name.push(name); this.funcTable.file.push(file); this.funcTable.line.push(line); this.funcMap.set(key, i); }
    return i;
  }
  internFrame(func, line, inlineDepth) {
    const key = func + '#' + line + '#' + inlineDepth;
    let i = this.frameMap.get(key);
    if (i === undefined) { i = this.frameTable.func.length; this.frameTable.func.push(func); this.frameTable.line.push(line); this.frameTable.inlineDepth.push(inlineDepth); this.frameMap.set(key, i); }
    return i;
  }
  internStack(frame, prefix) {
    const key = frame + '#' + prefix;
    let i = this.stackMap.get(key);
    if (i === undefined) { i = this.stackTable.frame.length; this.stackTable.frame.push(frame); this.stackTable.prefix.push(prefix); this.stackMap.set(key, i); }
    return i;
  }
  finish(threads, capabilities, metrics = []) {
    return { stringTable: this.stringTable, funcTable: this.funcTable, frameTable: this.frameTable, stackTable: this.stackTable, threads, metrics, capabilities };
  }
}

export function checkInvariants(p) {
  const errs = [];
  const nStr = p.stringTable.length, nFunc = p.funcTable.name.length, nFrame = p.frameTable.func.length, nStack = p.stackTable.frame.length;
  for (let i = 0; i < nFunc; i++) if (p.funcTable.name[i] < 0 || p.funcTable.name[i] >= nStr) errs.push(`func ${i}: name index out of range`);
  for (let i = 0; i < nFrame; i++) if (p.frameTable.func[i] < 0 || p.frameTable.func[i] >= nFunc) errs.push(`frame ${i}: func index out of range`);
  for (let i = 0; i < nStack; i++) {
    const fr = p.stackTable.frame[i], pf = p.stackTable.prefix[i];
    if (fr < 0 || fr >= nFrame) errs.push(`stack ${i}: frame index out of range`);
    if (pf < -1 || pf >= nStack) errs.push(`stack ${i}: prefix index out of range`);
    if (pf >= i) errs.push(`stack ${i}: prefix ${pf} not earlier (cycle risk)`);
  }
  for (const t of p.threads) {
    const len = t.samples.stack.length;
    for (let i = 0; i < len; i++) if (t.samples.stack[i] < -1 || t.samples.stack[i] >= nStack) errs.push(`thread ${t.name} sample ${i}: stack out of range`);
    for (const vt of p.capabilities.weightTypes) {
      const col = t.samples.weightsByType[vt];
      if (!col) errs.push(`thread ${t.name}: missing weight column "${vt}"`);
      else if (col.length !== len) errs.push(`thread ${t.name}: weight "${vt}" length ${col.length} != samples ${len}`);
    }
    if (p.capabilities.hasTiming) {
      if (!t.samples.time || t.samples.time.length !== len) errs.push(`thread ${t.name}: hasTiming but time length mismatch`);
      else for (let i = 1; i < t.samples.time.length; i++) if (t.samples.time[i] < t.samples.time[i - 1]) { errs.push(`thread ${t.name}: time not monotonic at ${i}`); break; }
    }
    if (!p.capabilities.isDiff) for (const vt of p.capabilities.weightTypes) { const col = t.samples.weightsByType[vt]; if (col) for (let i = 0; i < col.length; i++) if (col[i] < 0) { errs.push(`thread ${t.name}: negative weight in "${vt}" but not a diff`); break; } }
  }
  return errs;
}
