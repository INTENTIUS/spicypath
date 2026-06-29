// `perf script` text → canonical model (timed). Sample blocks separated by blank lines:
//   comm pid [cpu] <timestamp>: <period> <event>:
//       <addr> <symbol>+0xoff (dso)        ← leaf-first frames
// Pure (browser + Node).
import { ProfileBuilder } from './model.js';

// Normalize a raw DSO/binary string from a perf script frame into a short readable label.
// Returns '' when there is no DSO (so packageOf falls back to '(app)', unchanged behaviour).
function normalizeDso(raw) {
  if (!raw) return '';
  // Map kernel/special bracketed markers to readable labels.
  if (raw === '[kernel.kallsyms]' || raw === '[kernel]') return 'kernel';
  if (raw === '[vdso]') return 'vdso';
  if (raw === '[unknown]') return 'unknown';
  // For any other bracketed marker (e.g. [JIT], [heap]) keep the bare label.
  const bracket = raw.match(/^\[(.+)\]$/);
  if (bracket) return bracket[1];
  // Regular path: take the basename only.
  const slash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  return slash >= 0 ? raw.slice(slash + 1) : raw;
}

export function parsePerfScriptText(text) {
  const b = new ProfileBuilder();
  const stack = [], weights = [], time = [];
  let t = 0;
  for (const block of text.split(/\n[ \t]*\n/)) {
    const lines = block.split('\n').filter((l) => l.length);
    if (!lines.length) continue;
    const header = lines[0];
    if (/^\s/.test(header)) continue; // not a header block
    let weight = 1; const hm = header.match(/:\s+(\d+)\s+\S+:?\s*$/); if (hm) weight = Number(hm[1]);
    const tm = header.match(/\s(\d+\.\d+):/); t = tm ? Number(tm[1]) : t + 1;
    const frames = []; // leaf-first, each entry: [symbolName, dsoLabel]
    for (let i = 1; i < lines.length; i++) {
      const fl = lines[i].trim(); if (!fl) continue;
      const m = fl.match(/^\S+\s+(.+?)(?:\+0x[0-9a-f]+)?\s+\((.*)\)\s*$/);
      if (m) {
        frames.push([m[1], normalizeDso(m[2])]);
      } else {
        const sym = fl.replace(/^\S+\s+/, '').replace(/\s*\(.*\)\s*$/, '').replace(/\+0x[0-9a-f]+$/, '');
        frames.push([sym, '']);
      }
    }
    if (!frames.length) continue;
    let prefix = -1;
    for (let i = frames.length - 1; i >= 0; i--) {
      const [sym, dso] = frames[i];
      const fileIdx = dso ? b.internString(dso) : -1;
      prefix = b.internStack(b.internFrame(b.internFunc(b.internString(sym), fileIdx, -1), -1, 0), prefix);
    }
    stack.push(prefix); weights.push(weight); time.push(t);
  }
  return b.finish([{ name: 'perf', samples: { stack, weightsByType: { samples: weights }, time } }], { hasTiming: true, weightTypes: ['samples'], timeUnit: 'seconds', isDiff: false });
}
