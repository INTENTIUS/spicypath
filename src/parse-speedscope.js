// speedscope JSON (text) → canonical model. Handles sampled + evented. Pure (browser + Node).
import { ProfileBuilder } from './model.js';

export function parseSpeedscopeText(text) {
  const j = JSON.parse(text);
  const b = new ProfileBuilder();
  const frames = j.shared.frames;
  const frameRef = (i) => b.internFrame(b.internFunc(b.internString((frames[i] && frames[i].name) || ''), -1, -1), -1, 0);
  const prof = j.profiles[0];

  if (prof.type === 'evented') {
    const openFrames = [];
    const stack = [], weights = [], time = [];
    let prevAt = prof.startValue != null ? prof.startValue : (prof.events[0] ? prof.events[0].at : 0);
    const emit = (at) => {
      if (openFrames.length && at > prevAt) {
        let prefix = -1;
        for (const fi of openFrames) prefix = b.internStack(frameRef(fi), prefix);
        stack.push(prefix); weights.push(at - prevAt); time.push(prevAt);
      }
    };
    for (const e of prof.events) {
      emit(e.at);
      if (e.type === 'O') openFrames.push(e.frame);
      else { if (openFrames[openFrames.length - 1] === e.frame) openFrames.pop(); else { const k = openFrames.lastIndexOf(e.frame); if (k >= 0) openFrames.splice(k, 1); } }
      prevAt = e.at;
    }
    emit(prof.endValue != null ? prof.endValue : prevAt);
    return b.finish([{ name: prof.name || 'speedscope', samples: { stack, weightsByType: { samples: weights }, time } }], { hasTiming: true, weightTypes: ['samples'], timeUnit: prof.unit || 'none', isDiff: false });
  }

  // sampled
  const stack = [], weights = [];
  for (let s = 0; s < prof.samples.length; s++) {
    let prefix = -1;
    for (const fi of prof.samples[s]) prefix = b.internStack(frameRef(fi), prefix);
    stack.push(prefix); weights.push(prof.weights[s]);
  }
  return b.finish([{ name: prof.name || 'speedscope', samples: { stack, weightsByType: { samples: weights }, time: null } }], { hasTiming: false, weightTypes: ['samples'], isDiff: false });
}
