// A Scene is ONE format-neutral description of a profile. Per-format emitters serialize
// it (emit/*.js); the golden runner round-trips each format back through the parsers and
// asserts the call-tree distribution survived. Pure JS.
//
// Scene = {
//   name,
//   weightTypes: [string],          // canonical value types; [0] is the primary (comparable)
//   hasTiming: bool,
//   samples: [{ stack: [funcName, ...root→leaf], weight: number, time?: number }],
//   extraValues?: { [valueType]: (sample) => number },  // for multi-value (pprof)
// }
// Frame names use "pkg.func" so semantic color works through the whole pipeline.

export function valueOf(scene, sample, vt) {
  if (vt === scene.weightTypes[0]) return sample.weight;
  if (scene.extraValues && scene.extraValues[vt]) return scene.extraValues[vt](sample);
  if (vt === 'samples') return 1;
  return 0;
}

// path → fraction-of-total, by the PRIMARY weight. Unit-independent (fractions), so it
// matches any format whose carried value is proportional to weight.
export function sceneFractions(scene) {
  const m = new Map();
  let total = 0;
  for (const s of scene.samples) { const k = s.stack.join(';'); m.set(k, (m.get(k) || 0) + s.weight); total += s.weight; }
  const f = new Map();
  for (const [k, v] of m) f.set(k, v / (total || 1));
  return f;
}

// ---- preset builders ----
const seededRand = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function tiny() {
  return {
    name: 'tiny', weightTypes: ['cpu_nanos'], hasTiming: true,
    samples: [
      { stack: ['main', 'http.serve', 'router.handle', 'db.query'], weight: 50, time: 0 },
      { stack: ['main', 'http.serve', 'router.handle', 'json.encode'], weight: 30, time: 50 },
      { stack: ['main', 'runtime.gc', 'gc.mark'], weight: 20, time: 80 },
    ],
  };
}

function deepRecursion() {
  const samples = [];
  for (let n = 1; n <= 30; n++) {
    const stack = ['main', 'app.handle'];
    for (let i = 0; i < n; i++) stack.push('app.fib');
    samples.push({ stack, weight: 1, time: n });
  }
  return { name: 'deep-recursion', weightTypes: ['cpu_nanos'], hasTiming: true, samples };
}

function wideFanout() {
  const samples = [];
  for (let i = 0; i < 24; i++) samples.push({ stack: ['main', 'svc.dispatch', `handler.h${i}`], weight: 24 - i, time: i });
  return { name: 'wide-fanout', weightTypes: ['cpu_nanos'], hasTiming: true, samples };
}

function multiValue() {
  // cpu (primary) + samples count; exercises pprof multi-value.
  return {
    name: 'multi-value', weightTypes: ['cpu_nanos', 'samples'], hasTiming: false,
    extraValues: { samples: () => 1 },
    samples: [
      { stack: ['main', 'data.load', 'sql.exec'], weight: 100 },
      { stack: ['main', 'data.load', 'sql.exec'], weight: 100 },
      { stack: ['main', 'data.load', 'rows.scan'], weight: 40 },
      { stack: ['main', 'serialize.marshal'], weight: 60 },
    ],
  };
}

function allocHeap() {
  // alloc_bytes (primary) + alloc_objects count; exercises the byte-valued multi-value path
  // so that byte formatting (KB/MB/GB) and weight cycling are covered end-to-end.
  return {
    name: 'alloc-heap', weightTypes: ['alloc_bytes', 'alloc_objects'], hasTiming: false,
    extraValues: { alloc_objects: () => 1 },
    samples: [
      { stack: ['main', 'http.serve', 'json.marshal'],   weight: 512000  },  // 512 KB
      { stack: ['main', 'http.serve', 'json.marshal'],   weight: 512000  },  // 512 KB (dup path)
      { stack: ['main', 'http.serve', 'db.query'],       weight: 1048576 },  // 1 MB
      { stack: ['main', 'runtime.gc', 'gc.alloc'],       weight: 2097152 },  // 2 MB
    ],
  };
}

function unicode() {
  return {
    name: 'unicode', weightTypes: ['cpu_nanos'], hasTiming: false,
    samples: [
      { stack: ['main', 'café.résumé', 'λ.handle'], weight: 10 },
      { stack: ['main', 'café.résumé', '日本語.process'], weight: 20 },
      { stack: ['main', '<anonymous>'], weight: 5 },
    ],
  };
}

function scale(nSamples) {
  const rnd = seededRand(42);
  const tops = ['http.serve', 'grpc.serve', 'cron.run'];
  const mids = ['router.handle', 'mw.auth', 'mw.log'];
  const leaves = ['db.query', 'json.encode', 'cache.get', 'net.write', 'gc.mark'];
  const samples = [];
  for (let i = 0; i < nSamples; i++) {
    const stack = ['main', tops[(rnd() * tops.length) | 0], mids[(rnd() * mids.length) | 0], leaves[(rnd() * leaves.length) | 0]];
    samples.push({ stack, weight: 1 + ((rnd() * 5) | 0), time: i });
  }
  return { name: 'scale-' + nSamples, weightTypes: ['cpu_nanos'], hasTiming: true, samples };
}

export const PRESETS = [tiny(), deepRecursion(), wideFanout(), multiValue(), allocHeap(), unicode(), scale(5000)];
