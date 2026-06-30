// FG-042: Vaus mode — canvas game view (GameView extends BaseView).
// All interaction is owned here; dispose() removes every listener and stops rAF + audio.
// The host view is never mutated — only paused and repainted on exit.
import { BaseView } from './render-canvas.js';
import { colorForFunc } from './colors.js';
import {
  loadConfig, saveConfig,
  buildBricks, createGame,
  step, movePaddle, launch, fireLasers,
  destructiblesLeft,
} from './vaus.js';

const KONAMI = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];

// ── AudioSynth ────────────────────────────────────────────────────────────────────────────
// Synthesised SFX via Web Audio oscillators + gain envelopes. Created on first Start gesture
// (autoplay policy). All methods are no-ops when muted or unavailable.
class AudioSynth {
  constructor() { this._ctx = null; this._muted = false; }
  resume() {
    if (!this._ctx) {
      try { this._ctx = new AudioContext(); } catch { return; }
    }
    if (this._ctx.state === 'suspended') this._ctx.resume();
  }
  mute(v) { this._muted = v; }
  _beep(freq, dur, type = 'square', gain = 0.18, detune = 0) {
    if (this._muted || !this._ctx) return;
    try {
      const ctx = this._ctx;
      const osc = ctx.createOscillator();
      const gn  = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      osc.detune.value = detune;
      gn.gain.setValueAtTime(gain, ctx.currentTime);
      gn.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.connect(gn); gn.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + dur);
    } catch { /* AudioContext unavailable */ }
  }
  wall()           { this._beep(280, 0.08, 'sine', 0.12); }
  paddle()         { this._beep(340, 0.10, 'triangle', 0.18); }
  brickHit()       { this._beep(520, 0.07, 'square', 0.14); }
  brickIndes()     { this._beep(180, 0.12, 'sawtooth', 0.10); }
  brickDestroyed() { this._beep(680, 0.14, 'sine', 0.22, 1200); }
  powerUp()        { this._beep(880, 0.24, 'triangle', 0.20, 800); }
  ballLost()       { this._beep(160, 0.35, 'sawtooth', 0.15); }
  gameWon()        { for (let i = 0; i < 5; i++) setTimeout(() => this._beep(880 + i * 110, 0.18, 'sine', 0.22), i * 80); }
  gameLost()       { for (let i = 0; i < 3; i++) setTimeout(() => this._beep(200 - i * 30, 0.25, 'sawtooth', 0.15), i * 120); }
}

// ── POWERUP COLORS ───────────────────────────────────────────────────────────────────────
const POWERUP_COLORS = { 'multi-ball': '#f38ba8', 'wide-paddle': '#a6e3a1', 'slow-ball': '#89b4fa', 'laser': '#fab387' };

// ── GameView ─────────────────────────────────────────────────────────────────────────────
// Drives the Vaus sim over a snapshot of boxes from a host BaseView.
// The host view is left untouched; we overwrite the canvas and restore it on exit.
export class GameView extends BaseView {
  // boxes: read-only snapshot from the host view (array of {x,y,w,h,func,total,...})
  // profile: the profile object (for colorForFunc)
  // theme T: host's theme tokens (for color palette)
  // onExit: callback when the game ends or the user quits
  constructor(canvas, boxes, profile, theme, onExit) {
    // Construct BaseView with the profile but zero DOM interaction — we override draw()
    super(canvas, profile, (profile.capabilities.weightTypes || ['samples'])[0], 'graph', {});
    this.T = theme;
    this._boxes = boxes;   // frozen snapshot
    this._profile = profile;
    this._onExit = onExit;
    this._dpr = window.devicePixelRatio || 1;
    this._raf = 0;
    this._lastTs = null;
    this._muted = false;
    this._audio = new AudioSynth();
    this._game = null;     // created on Start

    // Load persisted config
    this._cfg = loadConfig();
    this._muted = !this._cfg.sound;
    this._audio.mute(this._muted);

    // Keyboard / mouse state
    this._keys = new Set();
    this._mouseX = canvas.clientWidth / 2;
    this._pendingFire = false;
    this._pendingLaunch = false;

    // Bind listeners (kept for removal). The pointer/key listeners are registered in the
    // CAPTURE phase and call stopImmediatePropagation so the host view's own canvas/window
    // listeners (hover, click-select, dblclick-zoom, wheel-zoom, Esc-brush, the app keymap)
    // never fire while the game overlays. The host is thus paused without being mutated —
    // its listeners stay attached and resume the instant GameView.dispose() runs.
    this._on = {
      keydown:   (e) => this._onKeyDown(e),
      keyup:     (e) => this._keys.delete(e.key),
      mousemove: (e) => this._onMouseMove(e),
      mousedown: (e) => { e.stopImmediatePropagation(); },
      click:     (e) => this._onCanvasClick(e),
      dblclick:  (e) => { e.stopImmediatePropagation(); },
      wheel:     (e) => { e.stopImmediatePropagation(); e.preventDefault(); },
      resize:    () => this._resize(),
    };
    window.addEventListener('keydown',   this._on.keydown,   true);
    window.addEventListener('keyup',     this._on.keyup);
    canvas.addEventListener('mousemove', this._on.mousemove, true);
    canvas.addEventListener('mousedown', this._on.mousedown, true);
    canvas.addEventListener('click',     this._on.click,     true);
    canvas.addEventListener('dblclick',  this._on.dblclick,  true);
    canvas.addEventListener('wheel',     this._on.wheel,     { capture: true, passive: false });
    window.addEventListener('resize',    this._on.resize);

    this._resize();
    this._startRaf();
  }

  // GameView overrides draw() — BaseView draw() is never called.
  draw() { this._paint(); }

  // Rebuild bricks from the box snapshot and start a new game (called on Start).
  _start() {
    this._audio.resume();
    const cfg = this._cfg;
    // Map flame-box depths to pixel rows that fill the top ~60% of the play area, leaving the
    // lower portion for the paddle/ball. Root (depth 0) lands at the top = the indestructible
    // back wall.
    let maxDepth = 0;
    for (const b of this._boxes) if ((b.depth || 0) > maxDepth) maxDepth = b.depth || 0;
    const top = 64;
    const rowH = Math.max(8, Math.min(22, (this._cssH * 0.6 - top) / (maxDepth + 1)));
    const layout = { top, rowH, gap: Math.min(3, rowH * 0.18) };
    const bricks = buildBricks(this._boxes, this._profile, cfg, layout);
    this._game = createGame(bricks, this._cssW, this._cssH, cfg);
    this._game.phase = 'playing';
    this._lastTs = null;
    saveConfig(cfg);
  }

  _resize() {
    const cv = this.canvas;
    const w = cv.clientWidth || cv.parentElement.clientWidth || 1000;
    const h = Math.max(160, (window.innerHeight || 800) - (cv.offsetTop || 0) - 8);
    this._cssW = w;
    this._cssH = h;
    cv.style.height = h + 'px';
    cv.width  = Math.floor(w * this._dpr);
    cv.height = Math.floor(h * this._dpr);
    // If a game is running, update its canvas dimensions
    if (this._game) {
      this._game.canvasW = w;
      this._game.canvasH = h;
      this._game.paddleY = h - this._game.paddleH - 16;
    }
  }

  _startRaf() {
    const tick = (ts) => {
      if (!this._rafRunning) return;
      this._raf = requestAnimationFrame(tick);
      const dt = this._lastTs != null ? Math.min((ts - this._lastTs) / 1000, 0.05) : 0;
      this._lastTs = ts;

      const g = this._game;
      if (g && g.phase === 'playing') {
        // Keyboard paddle movement
        if (this._keys.has('ArrowLeft') || this._keys.has('a') || this._keys.has('A')) {
          movePaddle(g, g.paddleX + g.paddleW / 2 - 280 * dt);
        }
        if (this._keys.has('ArrowRight') || this._keys.has('d') || this._keys.has('D')) {
          movePaddle(g, g.paddleX + g.paddleW / 2 + 280 * dt);
        }
        // Mouse paddle override
        movePaddle(g, this._mouseX);

        if (this._pendingLaunch) { launch(g); this._pendingLaunch = false; }
        if (this._pendingFire)   { fireLasers(g); this._pendingFire = false; }

        step(g, dt);
        this._handleEvents(g.events);
      }
      this._paint();
    };
    this._rafRunning = true;
    this._raf = requestAnimationFrame(tick);
  }

  _handleEvents(events) {
    if (!events || !events.length) return;
    for (const ev of events) {
      if (ev === 'wall')           this._audio.wall();
      else if (ev === 'paddle')    this._audio.paddle();
      else if (ev === 'brickHit')  this._audio.brickHit();
      else if (ev === 'brickIndes') this._audio.brickIndes();
      else if (ev === 'brickDestroyed') this._audio.brickDestroyed();
      else if (ev.startsWith('powerUp:')) this._audio.powerUp();
      else if (ev === 'ballLost')  this._audio.ballLost();
      else if (ev === 'gameWon')   { this._audio.gameWon(); setTimeout(() => this._exit(), 1800); }
      else if (ev === 'gameLost')  { this._audio.gameLost(); setTimeout(() => this._exit(), 2000); }
    }
  }

  _exit() { if (this._onExit) this._onExit(); }

  // ── input ──────────────────────────────────────────────────────────────────────────────
  _onKeyDown(e) {
    e.stopImmediatePropagation(); // swallow before the host view / app keymap can act
    this._keys.add(e.key);
    const g = this._game;
    if (e.key === ' ' || e.key === 'Space') {
      e.preventDefault();
      if (!g || g.phase === 'splash') { this._start(); return; }
      if (g.phase === 'playing') { this._pendingLaunch = true; this._pendingFire = true; }
      if (g.phase === 'paused') { g.phase = 'playing'; this._lastTs = null; }
    }
    if (e.key === 'p' || e.key === 'P') {
      if (g && g.phase === 'playing') g.phase = 'paused';
      else if (g && g.phase === 'paused') { g.phase = 'playing'; this._lastTs = null; }
    }
    if (e.key === 'Escape') {
      // Show pause overlay with Resume/Quit; if already paused + overlay shown, allow Quit
      if (!g || g.phase === 'splash') { this._exit(); return; }
      if (g.phase === 'playing') { g.phase = 'paused'; }
      else if (g.phase === 'paused') { this._exit(); }
    }
    if (e.key === 'm' || e.key === 'M') {
      this._muted = !this._muted;
      this._audio.mute(this._muted);
      this._cfg.sound = !this._muted;
      saveConfig(this._cfg);
    }
  }

  _onMouseMove(e) {
    e.stopImmediatePropagation();
    const r = this.canvas.getBoundingClientRect();
    this._mouseX = e.clientX - r.left;
  }

  _onCanvasClick(e) {
    e.stopImmediatePropagation();
    const g = this._game;
    if (!g || g.phase === 'splash') { this._start(); return; }
    if (g.phase === 'playing') { this._pendingLaunch = true; this._pendingFire = true; }
    if (g.phase === 'paused') { g.phase = 'playing'; this._lastTs = null; }
  }

  // ── drawing ────────────────────────────────────────────────────────────────────────────
  _paint() {
    const ctx = this.ctx;
    const dpr = this._dpr;
    const W = this._cssW, H = this._cssH;
    const T = this.T;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, W, H);

    const g = this._game;
    if (!g || g.phase === 'splash') {
      this._drawSplash(ctx, W, H, T);
      ctx.restore();
      return;
    }

    // Bricks
    for (const brick of g.bricks) {
      if (brick.destroyed) continue;
      const color = colorForFunc(this._profile, brick.func);
      const hpFrac = brick.indestructible ? 1 : (brick.hp / brick.maxHp);
      ctx.globalAlpha = brick.indestructible ? 0.55 : (0.45 + 0.55 * hpFrac);
      ctx.fillStyle = color;
      ctx.fillRect(brick.x, brick.y, brick.w - 1, brick.h - 1);
      if (brick.indestructible) {
        // Cross-hatch to signal indestructibility
        ctx.globalAlpha = 0.2;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(brick.x, brick.y);
        ctx.lineTo(brick.x + brick.w - 1, brick.y + brick.h - 1);
        ctx.moveTo(brick.x + brick.w - 1, brick.y);
        ctx.lineTo(brick.x, brick.y + brick.h - 1);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Power-ups
    for (const pu of g.powerUps) {
      ctx.fillStyle = POWERUP_COLORS[pu.type] || '#cdd6f4';
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(pu.x, pu.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#1e1e2e';
      ctx.font = '8px Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pu.type[0].toUpperCase(), pu.x, pu.y);
      ctx.textAlign = 'left';
    }

    // Paddle
    const paddleColor = (g.effects.laser > 0) ? '#fab387' : (g.effects.widePaddle > 0 ? '#a6e3a1' : T.accent);
    ctx.fillStyle = paddleColor;
    ctx.fillRect(g.paddleX, g.paddleY, g.paddleW, g.paddleH);

    // Laser beams
    if (g.effects.laser > 0 && g.lasers.length) {
      ctx.strokeStyle = '#fab387';
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.8;
      for (const lz of g.lasers) {
        ctx.beginPath();
        ctx.moveTo(lz.x, lz.y);
        ctx.lineTo(lz.x, 0);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Balls
    for (const ball of g.balls) {
      ctx.fillStyle = '#cdd6f4';
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // HUD: score, lives, effects
    this._drawHUD(ctx, g, W, T);

    // Pause overlay
    if (g.phase === 'paused') {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = T.fg;
      ctx.font = 'bold 28px Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Paused', W / 2, H / 2 - 28);
      ctx.font = '14px Helvetica, Arial, sans-serif';
      ctx.fillStyle = T.dim;
      ctx.fillText('Space / click  Resume', W / 2, H / 2 + 8);
      ctx.fillText('Esc  Quit', W / 2, H / 2 + 32);
      ctx.textAlign = 'left';
    }

    // Win / lose banners (before exit timer fires)
    if (g.phase === 'won') {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#a6e3a1';
      ctx.font = 'bold 36px Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('You cleared the profile!', W / 2, H / 2 - 20);
      ctx.font = '18px Helvetica, Arial, sans-serif';
      ctx.fillStyle = T.dim;
      ctx.fillText('Score: ' + g.score.toLocaleString(), W / 2, H / 2 + 20);
      ctx.textAlign = 'left';
    }
    if (g.phase === 'lost') {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#f38ba8';
      ctx.font = 'bold 36px Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Game over', W / 2, H / 2 - 20);
      ctx.font = '18px Helvetica, Arial, sans-serif';
      ctx.fillStyle = T.dim;
      ctx.fillText('Score: ' + g.score.toLocaleString(), W / 2, H / 2 + 20);
      ctx.textAlign = 'left';
    }

    ctx.restore();
  }

  _drawSplash(ctx, W, H, T) {
    ctx.fillStyle = T.fg;
    ctx.font = 'bold 30px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Vaus mode', W / 2, H / 2 - 110);
    ctx.font = '13px Helvetica, Arial, sans-serif';
    ctx.fillStyle = T.dim;
    ctx.fillText('FG-042  ·  homage to Taito\'s Arkanoid (1986)', W / 2, H / 2 - 80);

    const lines = [
      'Mouse  or  ← / →   move paddle',
      'Space  or  click    launch ball / fire',
      'P       pause',
      'Esc     pause → Quit',
      'M       mute / unmute',
    ];
    ctx.font = '13px Menlo, Consolas, monospace';
    ctx.fillStyle = T.fg;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], W / 2, H / 2 - 44 + i * 22);
    }

    // Config toggles: difficulty, indestructibles, power-ups
    const cfg = this._cfg;
    const toggles = [
      `difficulty: ${cfg.difficulty}`,
      `indestructible: ${cfg.indestructibleSet}`,
      `power-ups: ${cfg.powerUps ? 'on' : 'off'}`,
      `sound: ${!this._muted ? 'on' : 'off'}`,
    ];
    ctx.font = '11px Menlo, Consolas, monospace';
    ctx.fillStyle = T.faint;
    for (let i = 0; i < toggles.length; i++) {
      ctx.fillText(toggles[i], W / 2, H / 2 + 68 + i * 17);
    }

    // Start prompt
    ctx.font = 'bold 18px Helvetica, Arial, sans-serif';
    ctx.fillStyle = T.accent;
    ctx.fillText('Space or click to Start', W / 2, H / 2 + 145);
    ctx.textAlign = 'left';
  }

  _drawHUD(ctx, g, W, T) {
    ctx.save();
    ctx.font = '12px Menlo, Consolas, monospace';
    ctx.textBaseline = 'top';
    ctx.fillStyle = T.dim;
    ctx.fillText('Score: ' + g.score.toLocaleString(), 10, 8);
    const liveTxt = 'Lives: ' + '● '.repeat(Math.max(0, g.lives)).trim();
    ctx.fillStyle = g.lives <= 1 ? '#f38ba8' : T.dim;
    ctx.fillText(liveTxt, 10, 24);
    // Active effects HUD
    const eff = [];
    if (g.effects.widePaddle > 0) eff.push('wide');
    if (g.effects.slowBall > 0)   eff.push('slow');
    if (g.effects.laser > 0)      eff.push('laser');
    if (eff.length) {
      ctx.fillStyle = '#fab387';
      ctx.fillText(eff.join(' + '), W - 120, 8);
    }
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  // Test hook: step the sim by dt seconds without touching the rAF loop.
  _stepForTest(dt, opts) {
    if (this._game) step(this._game, dt, opts);
  }

  // ── dispose: remove ALL listeners, stop rAF, stop audio ─────────────────────────────
  dispose() {
    this._rafRunning = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    window.removeEventListener('keydown',   this._on.keydown,   true);
    window.removeEventListener('keyup',     this._on.keyup);
    this.canvas.removeEventListener('mousemove', this._on.mousemove, true);
    this.canvas.removeEventListener('mousedown', this._on.mousedown, true);
    this.canvas.removeEventListener('click',     this._on.click,     true);
    this.canvas.removeEventListener('dblclick',  this._on.dblclick,  true);
    this.canvas.removeEventListener('wheel',     this._on.wheel,     { capture: true });
    window.removeEventListener('resize',    this._on.resize);
    // Restore the canvas to its CSS-driven height (the game forced an inline height); the
    // host view's relayout() on quit recomputes its own size from this baseline.
    try { this.canvas.style.height = ''; } catch { /* ignore */ }
    // Close AudioContext
    try { if (this._audio._ctx) this._audio._ctx.close(); } catch { /* ignore */ }
    this._game = null;
  }

  // ── BaseView stubs (GameView does not use relayout/updateLegend/updateDetail) ─────────
  relayout() { this._resize(); }
  _updateLegend() {}
  _updateDetail() {}
}

// Expose Konami sequence for use by index.html
export { KONAMI };
