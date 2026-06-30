// FG-042: Vaus mode — pure simulation (no DOM, no canvas, no audio).
// The flame-graph boxes become Arkanoid bricks. The ball and paddle (Vaus) are driven
// by a deterministic step(dt) function; callers supply rAF timing. No globals leak.

// ── gameConfig ──────────────────────────────────────────────────────────────────────────
// Schema + defaults. Persisted to localStorage under key `fv-vaus-config`.

export const DEFAULT_CONFIG = {
  difficulty: 'normal',  // 'easy' | 'normal' | 'hard'
  lives: 3,
  toughnessCap: 6,       // max hit-points for any brick
  indestructibleSet: 'root+runtime+gc', // 'off' | 'root' | 'root+runtime+gc'
  powerUps: true,
  powerUpRate: 0.18,     // probability a heavy brick drops a power-up on destruction
  sound: true,
};

const CONFIG_KEY = 'fv-vaus-config';

export function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return Object.assign({}, DEFAULT_CONFIG, JSON.parse(raw));
  } catch { /* private mode or bad JSON */ }
  return Object.assign({}, DEFAULT_CONFIG);
}

export function saveConfig(cfg) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

// ── difficulty → derived constants ──────────────────────────────────────────────────────
function difficultyParams(difficulty) {
  if (difficulty === 'easy')   return { ballSpeed: 220, paddleW: 110 };
  if (difficulty === 'hard')   return { ballSpeed: 380, paddleW: 70  };
  return                              { ballSpeed: 290, paddleW: 88  };
}

// ── brick classification ─────────────────────────────────────────────────────────────────
// Patterns that identify indestructible frames.
const ROOT_RE    = /^(main|<root>|\(root\)|root)$/i;
const RUNTIME_RE = /^(runtime\.|_rt|goroutine|go\.runtime)/i;
const GC_RE      = /^(gc\.|runtime\.gc|runtime\.mallocgc|runtime\.morestack)/i;

export function isIndestructible(funcName, set) {
  if (set === 'off') return false;
  if (ROOT_RE.test(funcName)) return true;
  if (set === 'root+runtime+gc') {
    if (RUNTIME_RE.test(funcName)) return true;
    if (GC_RE.test(funcName)) return true;
  }
  return false;
}

// Weight → hit-points. Heavier bricks take more hits, capped at toughnessCap.
// sqrt curve: gives mid-weight bricks 2-3 hits without extreme values.
export function weightToHp(total, grandTotal, cap) {
  if (!grandTotal || total <= 0) return 1;
  const frac = total / grandTotal;
  const raw = 1 + Math.round(Math.sqrt(frac) * (cap - 1));
  return Math.max(1, Math.min(cap, raw));
}

// ── buildBricks(boxes, profile, gameConfig, layout) ──────────────────────────────────────
// Returns an array of brick objects built from a snapshot of flame-graph boxes.
// Each brick: { x, y, w, h, func, funcName, hp, maxHp, indestructible, destroyed, total }
// Flame boxes carry { x, w, depth } (a row index), not pixel y/h — so unless a box already
// has an explicit y (the test path), we map its `depth` to a pixel row via `layout`:
//   y = top + depth*rowH, h = rowH - gap.  Root (depth 0) sits at the top = the back wall.
export function buildBricks(boxes, profile, gameConfig, layout) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, gameConfig);
  const cap = Math.max(1, (cfg.toughnessCap | 0) || 1);
  const iset = cfg.indestructibleSet;
  const lay = Object.assign({ top: 64, rowH: 20, gap: 3 }, layout);

  // Compute grandTotal from the snapshot boxes.
  let grandTotal = 0;
  for (const b of boxes) grandTotal += (b.total || 0);

  const bricks = [];
  for (const b of boxes) {
    const name = profile
      ? (profile.stringTable[profile.funcTable.name[b.func]] || '')
      : (b._vausFuncName || '');
    const indes = isIndestructible(name, iset);
    const hp = indes ? Infinity : weightToHp(b.total || 0, grandTotal, cap);
    // Explicit y/h (test fixtures) win; otherwise derive from the box's depth row.
    const y = b.y != null ? b.y : (lay.top + (b.depth || 0) * lay.rowH);
    const h = b.h != null ? b.h : Math.max(4, lay.rowH - lay.gap);
    bricks.push({
      x:             b.x,
      y,
      w:             b.w,
      h,
      func:          b.func,
      funcName:      name,
      total:         b.total || 0,
      hp,
      maxHp:         hp,
      indestructible: indes,
      destroyed:     false,
    });
  }
  return bricks;
}

// ── POWER-UP TYPES ──────────────────────────────────────────────────────────────────────
export const POWERUP_TYPES = ['multi-ball', 'wide-paddle', 'slow-ball', 'laser'];

// ── GameState ────────────────────────────────────────────────────────────────────────────
// Full simulation state. Created by createGame(), stepped by step(dt).
// All dimensions in CSS pixels.

export function createGame(bricks, canvasW, canvasH, gameConfig) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, gameConfig);
  const params = difficultyParams(cfg.difficulty);

  const PADDLE_H = 10;
  const BALL_R   = 7;
  const paddleY  = canvasH - PADDLE_H - 16;
  const paddleX  = (canvasW - params.paddleW) / 2;

  return {
    phase: 'splash',  // 'splash' | 'playing' | 'paused' | 'won' | 'lost'
    bricks,
    canvasW,
    canvasH,

    paddleX,
    paddleY,
    paddleW: params.paddleW,
    paddleH: PADDLE_H,

    // balls: [{ x, y, vx, vy, r, launched }]
    balls: [{
      x: paddleX + params.paddleW / 2,
      y: paddleY - BALL_R - 1,
      vx: 0, vy: 0, r: BALL_R, launched: false,
    }],

    score: 0,
    lives: cfg.lives,
    BALL_R,
    PADDLE_H,
    baseSpeed: params.ballSpeed,

    // power-ups in flight: [{ x, y, vy, type }]
    powerUps: [],

    // active effects
    effects: { widePaddle: 0, slowBall: 0, laser: 0 },

    // laser projectiles: [{ x, y }]
    lasers: [],

    // events emitted this step (for sound/visual cues); cleared each step
    events: [],

    _cfg: cfg,
    _grandTotal: bricks.reduce((s, b) => s + b.total, 0),
  };
}

// ── step(state, dt, opts?) ───────────────────────────────────────────────────────────────
// Advance simulation by dt seconds. Mutates state in-place.
// opts.rng: () => [0,1) random source (defaults to Math.random; override for tests).
export function step(state, dt, opts) {
  if (state.phase !== 'playing') return;
  state.events = [];

  const rng = (opts && opts.rng) ? opts.rng : Math.random;
  const cfg = state._cfg;
  const speedMult = (state.effects.slowBall > 0) ? 0.45 : 1.0;

  // 1. Move each ball
  for (const ball of state.balls) {
    if (!ball.launched) {
      ball.x = state.paddleX + state.paddleW / 2;
      ball.y = state.paddleY - ball.r - 1;
      continue;
    }

    const sp = state.baseSpeed * speedMult;
    const len = Math.hypot(ball.vx, ball.vy) || sp;
    ball.vx = (ball.vx / len) * sp;
    ball.vy = (ball.vy / len) * sp;

    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // Wall reflections
    if (ball.x - ball.r < 0) {
      ball.x = ball.r;
      ball.vx = Math.abs(ball.vx);
      state.events.push('wall');
    }
    if (ball.x + ball.r > state.canvasW) {
      ball.x = state.canvasW - ball.r;
      ball.vx = -Math.abs(ball.vx);
      state.events.push('wall');
    }
    if (ball.y - ball.r < 0) {
      ball.y = ball.r;
      ball.vy = Math.abs(ball.vy);
      state.events.push('wall');
    }

    // Bottom — ball lost
    if (ball.y - ball.r > state.canvasH) {
      ball._lost = true;
      state.events.push('ballLost');
      continue;
    }

    // Paddle collision
    if (
      ball.vy > 0 &&
      ball.y + ball.r >= state.paddleY &&
      ball.y - ball.r <= state.paddleY + state.paddleH &&
      ball.x >= state.paddleX - ball.r &&
      ball.x <= state.paddleX + state.paddleW + ball.r
    ) {
      ball.y = state.paddleY - ball.r - 0.5;
      ball.vy = -Math.abs(ball.vy);
      // English: apply angle based on hit offset from paddle center
      const offset = (ball.x - (state.paddleX + state.paddleW / 2)) / (state.paddleW / 2);
      const angleMax = Math.PI * 0.38;
      const angle = offset * angleMax;
      const spd = Math.hypot(ball.vx, ball.vy) || sp;
      ball.vx = Math.sin(angle) * spd;
      ball.vy = -Math.cos(angle) * spd;
      state.events.push('paddle');
    }

    // Brick collisions (AABB, correct face normal)
    for (const brick of state.bricks) {
      if (brick.destroyed) continue;
      const face = _ballBrickCollide(ball, brick);
      if (!face) continue;

      state.events.push(brick.indestructible ? 'brickIndes' : 'brickHit');

      if (!brick.indestructible) {
        brick.hp -= 1;
        if (brick.hp <= 0) {
          brick.destroyed = true;
          state.score += brick.total || 1;
          state.events.push('brickDestroyed');

          // Power-up drop from heavy bricks
          if (cfg.powerUps && brick.maxHp >= 3 && rng() < cfg.powerUpRate) {
            const type = POWERUP_TYPES[Math.floor(rng() * POWERUP_TYPES.length)];
            state.powerUps.push({ x: brick.x + brick.w / 2, y: brick.y + brick.h, vy: 90, type });
          }
        }
      }

      // Reflect off the face hit
      if (face === 'top' || face === 'bottom') {
        ball.vy = -ball.vy;
      } else {
        ball.vx = -ball.vx;
      }
      _nudgeBall(ball, brick, face);
    }
  }

  // 2. Handle lost balls
  const lostCount = state.balls.filter((b) => b._lost).length;
  state.balls = state.balls.filter((b) => !b._lost);
  if (lostCount > 0 && state.balls.length === 0) {
    state.lives -= 1;
    if (state.lives <= 0) {
      state.phase = 'lost';
      state.events.push('gameLost');
      return;
    }
    state.balls.push({
      x: state.paddleX + state.paddleW / 2,
      y: state.paddleY - state.BALL_R - 1,
      vx: 0, vy: 0, r: state.BALL_R, launched: false,
    });
    state.events.push('respawn');
  }

  // 3. Power-ups fall + collection
  for (const pu of state.powerUps) pu.y += pu.vy * dt;
  const collected = state.powerUps.filter((pu) =>
    pu.y + 10 >= state.paddleY &&
    pu.y <= state.paddleY + state.paddleH + 10 &&
    pu.x >= state.paddleX &&
    pu.x <= state.paddleX + state.paddleW
  );
  for (const pu of collected) {
    _applyPowerUp(state, pu.type, rng);
    state.events.push('powerUp:' + pu.type);
  }
  state.powerUps = state.powerUps.filter((pu) => !collected.includes(pu) && pu.y < state.canvasH + 20);

  // 4. Laser projectiles
  if (state.effects.laser > 0) {
    for (const lz of state.lasers) lz.y -= 320 * dt;
    for (const brick of state.bricks) {
      if (brick.destroyed || brick.indestructible) continue;
      for (const lz of state.lasers) {
        if (lz.y >= brick.y && lz.y <= brick.y + brick.h && lz.x >= brick.x && lz.x <= brick.x + brick.w) {
          brick.hp = Math.max(0, brick.hp - 1);
          if (brick.hp <= 0) {
            brick.destroyed = true;
            state.score += brick.total || 1;
            state.events.push('brickDestroyed');
          }
          lz._hit = true;
        }
      }
    }
    state.lasers = state.lasers.filter((lz) => !lz._hit && lz.y > -10);
  }

  // 5. Decay timed effects (seconds)
  for (const k of Object.keys(state.effects)) {
    if (state.effects[k] > 0) state.effects[k] = Math.max(0, state.effects[k] - dt);
  }

  // 6. Check win
  const destructibles = state.bricks.filter((b) => !b.indestructible);
  if (destructibles.length > 0 && destructibles.every((b) => b.destroyed)) {
    state.phase = 'won';
    state.events.push('gameWon');
  }
}

// ── paddle / launch / laser helpers ─────────────────────────────────────────────────────
export function movePaddle(state, targetX) {
  const maxX = state.canvasW - state.paddleW;
  state.paddleX = Math.max(0, Math.min(maxX, targetX - state.paddleW / 2));
  for (const b of state.balls) {
    if (!b.launched) { b.x = state.paddleX + state.paddleW / 2; b.y = state.paddleY - b.r - 1; }
  }
}

export function launch(state) {
  for (const b of state.balls) {
    if (!b.launched) {
      b.launched = true;
      const angle = (Math.random() - 0.5) * 0.6;
      const sp = state.baseSpeed;
      b.vx = Math.sin(angle) * sp;
      b.vy = -Math.cos(angle) * sp;
    }
  }
}

export function fireLasers(state) {
  if (state.effects.laser <= 0) return;
  state.lasers.push({ x: state.paddleX + 4, y: state.paddleY });
  state.lasers.push({ x: state.paddleX + state.paddleW - 4, y: state.paddleY });
}

// ── internal AABB collision helpers ─────────────────────────────────────────────────────
// Returns the face hit ('top'|'bottom'|'left'|'right') or null.
function _ballBrickCollide(ball, brick) {
  const { x: bx, y: by, w: bw, h: bh } = brick;
  const { x, y, r } = ball;

  if (x + r < bx || x - r > bx + bw || y + r < by || y - r > by + bh) return null;

  const overlapLeft   = (x + r) - bx;
  const overlapRight  = (bx + bw) - (x - r);
  const overlapTop    = (y + r) - by;
  const overlapBottom = (by + bh) - (y - r);

  const horizMin = Math.min(overlapLeft, overlapRight);
  const vertMin  = Math.min(overlapTop, overlapBottom);

  if (vertMin <= horizMin) {
    // Hit top or bottom face
    if (overlapTop < overlapBottom) return 'top';
    return 'bottom';
  } else {
    // Hit left or right face
    if (overlapLeft < overlapRight) return 'left';
    return 'right';
  }
}

function _nudgeBall(ball, brick, face) {
  const { x: bx, y: by, w: bw, h: bh } = brick;
  if (face === 'top')    { ball.y = by - ball.r - 0.5; }
  else if (face === 'bottom') { ball.y = by + bh + ball.r + 0.5; }
  else if (face === 'left')   { ball.x = bx - ball.r - 0.5; }
  else if (face === 'right')  { ball.x = bx + bw + ball.r + 0.5; }
}

function _applyPowerUp(state, type, rng) {
  const params = difficultyParams(state._cfg.difficulty);
  if (type === 'multi-ball') {
    const extras = [];
    for (const b of state.balls) {
      if (!b.launched) continue;
      const sp = Math.hypot(b.vx, b.vy) || state.baseSpeed;
      for (let i = 0; i < 2; i++) {
        const angle = Math.PI * (0.1 + rng() * 0.8);
        extras.push({ x: b.x, y: b.y, vx: Math.cos(angle) * sp, vy: -Math.abs(Math.sin(angle)) * sp, r: b.r, launched: true });
      }
    }
    state.balls.push(...extras);
  } else if (type === 'wide-paddle') {
    state.effects.widePaddle = 12;
    state.paddleW = Math.min(state.canvasW * 0.4, params.paddleW * 1.7);
  } else if (type === 'slow-ball') {
    state.effects.slowBall = 10;
  } else if (type === 'laser') {
    state.effects.laser = 15;
  }
}

// ── query helpers ────────────────────────────────────────────────────────────────────────
export function destructiblesLeft(state) {
  return state.bricks.filter((b) => !b.indestructible && !b.destroyed).length;
}

export function destructiblesTotal(state) {
  return state.bricks.filter((b) => !b.indestructible).length;
}
