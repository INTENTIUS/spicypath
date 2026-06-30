// FG-042 — unit tests for src/vaus.js (the pure Vaus simulation).
// Pure Node, no DOM, no canvas, no audio.
//   node test/vaus-test.ts
//
// Covers: brick build + indestructible classification, weight→HP curve, deterministic
// ball/brick face reflection, HP decrement + destruction, indestructible survival,
// win/lose transitions, and gameConfig load/save round-trip.

import {
  DEFAULT_CONFIG, loadConfig, saveConfig,
  isIndestructible, weightToHp,
  buildBricks, createGame, step,
  destructiblesLeft, destructiblesTotal,
} from '../src/vaus.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// A box snapshot fixture. Boxes carry _vausFuncName so buildBricks needs no profile.
// Explicit x/y/w/h bypasses the depth→pixel mapping (that path is exercised by the game view).
const box = (name: string, total: number, x: number, y: number, w = 60, h = 20) =>
  ({ _vausFuncName: name, func: 0, total, x, y, w, h });

// ── 1. brick build + indestructible classification ───────────────────────────────────────
{
  const boxes = [
    box('main', 1000, 0, 0),
    box('runtime.mallocgc', 200, 60, 0),
    box('app.handler', 300, 120, 0),
    box('app.parse', 100, 180, 0),
  ];

  const bricksAll = buildBricks(boxes, null, { indestructibleSet: 'root+runtime+gc' });
  check('brick count == box count', bricksAll.length === boxes.length, `${bricksAll.length}`);

  const byName = (bs: any[], n: string) => bs.find((b) => b.funcName === n);
  check('root indestructible (root+runtime+gc)', byName(bricksAll, 'main').indestructible === true);
  check('runtime/gc indestructible (root+runtime+gc)', byName(bricksAll, 'runtime.mallocgc').indestructible === true);
  check('app frame destructible', byName(bricksAll, 'app.handler').indestructible === false);

  const bricksRoot = buildBricks(boxes, null, { indestructibleSet: 'root' });
  check('runtime destructible when set=root', byName(bricksRoot, 'runtime.mallocgc').indestructible === false);
  check('root still indestructible when set=root', byName(bricksRoot, 'main').indestructible === true);

  const bricksOff = buildBricks(boxes, null, { indestructibleSet: 'off' });
  check('nothing indestructible when set=off', bricksOff.every((b) => !b.indestructible));

  // direct classifier sanity
  check('isIndestructible main', isIndestructible('main', 'root') === true);
  check('isIndestructible off short-circuits', isIndestructible('main', 'off') === false);
}

// ── 2. weight → HP curve (heavier = more hits, capped, ≥1) ────────────────────────────────
{
  const cap = 6;
  const trivial = weightToHp(1, 100000, cap);
  const heavy   = weightToHp(90000, 100000, cap);
  check('trivial leaf = 1 HP', trivial === 1, `${trivial}`);
  check('heavy brick > trivial', heavy > trivial, `heavy=${heavy}`);
  check('HP capped at cap', heavy <= cap && weightToHp(1e9, 1e9, cap) <= cap);
  check('HP never below 1', weightToHp(0, 100000, cap) >= 1 && weightToHp(-5, 100, cap) >= 1);
}

// ── 3. deterministic face reflection + HP/destruction ─────────────────────────────────────
// Helper: a game with one brick, ball placed adjacent, stepped once.
function collideOnce(brickName: string, set: string, ballInit: any, dt = 0.05, cap = 6) {
  const boxes = [box(brickName, 500, 300, 100)];
  const bricks = buildBricks(boxes, null, { indestructibleSet: set, toughnessCap: cap });
  const g = createGame(bricks, 800, 600, DEFAULT_CONFIG);
  g.phase = 'playing';
  g.balls = [{ ...ballInit, r: 7, launched: true }];
  step(g, dt, { rng: () => 0.99 }); // rng high → no power-up drop, deterministic
  return { g, brick: g.bricks[0], ball: g.balls[0] };
}

{
  // Ball below the brick (brick y 100..120), moving up → hits the BOTTOM face → vy flips +.
  const fromBelow = collideOnce('app.x', 'off', { x: 330, y: 132, vx: 0, vy: -290 });
  check('bottom-face hit flips vy to +', fromBelow.ball.vy > 0, `vy=${fromBelow.ball.vy.toFixed(0)}`);

  // Ball left of the brick (brick x 300..360), moving right → hits the LEFT face → vx flips -.
  const fromLeft = collideOnce('app.y', 'off', { x: 286, y: 110, vx: 290, vy: 1 });
  check('left-face hit flips vx to -', fromLeft.ball.vx < 0, `vx=${fromLeft.ball.vx.toFixed(0)}`);

  // Destructible brick with hp 1 (cap=1) → one hit destroys it; score credited.
  const destroyed = collideOnce('app.z', 'off', { x: 330, y: 132, vx: 0, vy: -290 }, 0.05, 1);
  check('destructible 1-HP brick destroyed on hit', destroyed.brick.destroyed === true);
  check('score credited on destruction', destroyed.g.score > 0, `score=${destroyed.g.score}`);

  // Indestructible brick survives repeated hits but still reflects.
  {
    const boxes = [box('main', 500, 300, 100)];
    const bricks = buildBricks(boxes, null, { indestructibleSet: 'root' });
    const g = createGame(bricks, 800, 600, DEFAULT_CONFIG);
    g.phase = 'playing';
    let reflected = false;
    for (let i = 0; i < 5; i++) {
      g.balls = [{ x: 330, y: 132, vx: 0, vy: -290, r: 7, launched: true }];
      step(g, 0.05, { rng: () => 0.99 });
      if (g.balls[0].vy > 0) reflected = true;
    }
    check('indestructible brick survives 5 hits', g.bricks[0].destroyed === false);
    check('indestructible brick still reflects', reflected === true);
  }
}

// ── 4. win / lose transitions ─────────────────────────────────────────────────────────────
{
  // Win: destroy the only destructible brick (root brick is indestructible → ignored for win).
  const boxes = [box('main', 1000, 0, 100), box('app.only', 200, 60, 100)];
  const bricks = buildBricks(boxes, null, { indestructibleSet: 'root', toughnessCap: 1 });
  const g = createGame(bricks, 800, 600, DEFAULT_CONFIG);
  g.phase = 'playing';
  check('one destructible to clear', destructiblesTotal(g) === 1 && destructiblesLeft(g) === 1);
  // Aim the ball at the app brick (x 60..120, y 100..120) from below.
  g.balls = [{ x: 90, y: 132, vx: 0, vy: -290, r: 7, launched: true }];
  step(g, 0.05, { rng: () => 0.99 });
  check('win when all destructibles cleared', g.phase === 'won', `phase=${g.phase}`);

  // Lose: last life, ball falls past the bottom.
  const g2 = createGame(buildBricks([box('app.a', 100, 0, 100)], null, {}), 800, 600, { ...DEFAULT_CONFIG, lives: 1 });
  g2.phase = 'playing';
  g2.balls = [{ x: 400, y: 595, vx: 0, vy: 290, r: 7, launched: true }];
  step(g2, 0.05, { rng: () => 0.99 }); // ball passes canvasH=600 → lost life → 0 lives → lost
  check('lose when last ball drops and lives exhausted', g2.phase === 'lost', `phase=${g2.phase}, lives=${g2.lives}`);
}

// ── 5. gameConfig load/save round-trip (localStorage stub) ────────────────────────────────
{
  const storeBacked = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (storeBacked.has(k) ? storeBacked.get(k)! : null),
    setItem: (k: string, v: string) => { storeBacked.set(k, String(v)); },
    removeItem: (k: string) => { storeBacked.delete(k); },
  };

  const fresh = loadConfig();
  check('loadConfig returns defaults when empty', fresh.lives === DEFAULT_CONFIG.lives && fresh.indestructibleSet === DEFAULT_CONFIG.indestructibleSet);

  saveConfig({ ...DEFAULT_CONFIG, lives: 5, difficulty: 'hard', sound: false });
  const back = loadConfig();
  check('config round-trips through localStorage', back.lives === 5 && back.difficulty === 'hard' && back.sound === false);
  check('round-trip preserves unset defaults', back.toughnessCap === DEFAULT_CONFIG.toughnessCap);

  delete (globalThis as any).localStorage;
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
