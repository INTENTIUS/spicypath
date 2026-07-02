// macOS `sample`(1) / Instruments "Call graph" indented call-tree text → canonical model.
// FG-055: a stack-shaped format (stacks + sample counts) that reduces to the existing model —
// no model change. Pure (browser + Node).
//
// Format (one tree per thread):
//   Analysis of sampling <proc> (pid N) every M milliseconds
//   ...header...
//   Call graph:
//       176 Thread_4796196   DispatchQueue_1: com.apple.main-thread  (serial)
//       + 176 start  (in dyld) + 6992  [0x…]
//       +   176 main  (in node) + 604  [0x…]
//       +     100 foo  (in app) + 12  [0x…]
//       ...
//       30 Thread_4796199: Worker
//       ...
//   (blank line)
//   Total number in stack …   ← ends the graph
//
// A `Thread_…` line (no `+`) starts a new thread; `+`-prefixed lines are frames whose leading
// indentation encodes depth. The count on each line is the SUBTREE total (self + descendants), so
// a node's self weight is its count minus the sum of its direct children's counts. Each frame
// carries its module as `(in <module>)` — kept as the func's file so views colour by shared object.

import { ProfileBuilder } from './model.js';

// Indent prefix may mix spaces and sample's tree-drawing markers (+ ! : |), then the count.
const FRAME = /^([\s+!:|]*)(\d+)\s+(.*)$/;

export function parseSampleText(text) {
  const b = new ProfileBuilder();
  const lines = text.split('\n');

  let i = 0;
  while (i < lines.length && !/^Call graph:/.test(lines[i])) i++;
  i++; // past the "Call graph:" line

  const threads = [];
  let nodes = null;   // node list for the current thread: { stackId, count, childSum }
  let name = null;
  let stack = [];     // [{ indent, node }] — open ancestors by indentation

  const flush = () => {
    if (!nodes || !nodes.length) return;
    const stackCol = [], weights = [];
    for (const nd of nodes) {
      const self = nd.count - nd.childSum;      // self = subtree total − children totals
      if (self > 0) { stackCol.push(nd.stackId); weights.push(self); }
    }
    threads.push({ name: name || `thread ${threads.length}`, samples: { stack: stackCol, weightsByType: { samples: weights }, time: null } });
  };

  for (; i < lines.length; i++) {
    const m = lines[i].match(FRAME);
    if (!m) { if (!lines[i].trim()) continue; break; } // blank = skip; any other non-frame line ends the graph
    const indentStr = m[1];
    const count = Number(m[2]);
    const rest = m[3];

    // A thread header has only spaces in its indent (no + ! : | tree markers) and names a thread.
    if (!/[+!:|]/.test(indentStr) && /^Thread_/.test(rest)) {
      flush();
      nodes = []; stack = [];
      name = rest.replace(/^Thread_\S+\s*:?\s*/, '').replace(/\s+\(serial\)\s*$/, '').trim() || rest.trim();
      continue;
    }
    if (!nodes) continue; // a frame before any thread header — ignore

    const indent = indentStr.length;

    // Symbol + module: "sym  (in module) + off  [0x…]" — module is optional.
    let sym = rest, fileStr = -1;
    const inIdx = rest.indexOf('  (in ');
    if (inIdx >= 0) {
      sym = rest.slice(0, inIdx).trim();
      const after = rest.slice(inIdx + 6);
      const close = after.indexOf(')');
      if (close >= 0) fileStr = b.internString(after.slice(0, close).trim());
    } else {
      sym = rest.replace(/\s+\+\s+\d+\b.*$/, '').replace(/\s+\[0x[0-9a-f]+\]\s*$/i, '').trim();
    }

    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const prefix = stack.length ? stack[stack.length - 1].node.stackId : -1;
    const stackId = b.internStack(b.internFrame(b.internFunc(b.internString(sym), fileStr, -1), -1, 0), prefix);
    const node = { stackId, count, childSum: 0 };
    if (stack.length) stack[stack.length - 1].node.childSum += count;
    nodes.push(node);
    stack.push({ indent, node });
  }
  flush();

  if (!threads.length) threads.push({ name: 'sample', samples: { stack: [], weightsByType: { samples: [] }, time: null } });
  return b.finish(threads, { hasTiming: false, weightTypes: ['samples'], isDiff: false });
}
