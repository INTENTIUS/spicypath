// folded/collapsed stacks (text) → canonical model. Pure (browser + Node).
import { ProfileBuilder } from './model.js';

export function parseFoldedText(text) {
  const b = new ProfileBuilder();
  const stack = [];
  const samples = [];
  for (const line of text.split('\n')) {
    const t = line.trimEnd();
    if (!t) continue;
    const sp = t.lastIndexOf(' ');
    if (sp < 0) continue;
    const count = Number(t.slice(sp + 1));
    if (!Number.isFinite(count)) continue;
    let prefix = -1;
    for (const fn of t.slice(0, sp).split(';')) prefix = b.internStack(b.internFrame(b.internFunc(b.internString(fn), -1, -1), -1, 0), prefix);
    stack.push(prefix);
    samples.push(count);
  }
  return b.finish([{ name: 'folded', samples: { stack, weightsByType: { samples }, time: null } }], { hasTiming: false, weightTypes: ['samples'], isDiff: false });
}
