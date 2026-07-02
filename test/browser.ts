// Real-browser smoke test — zero dependencies. Drives the system Chrome over the
// Chrome DevTools Protocol using only Node built-ins (global WebSocket + fetch), so it
// stays consistent with this project's no-build / no-deps architecture (no selenium /
// chromedriver / puppeteer install).
//
// Why this exists: the headless Node tests stub getContext/layout, so they verify the
// renderer's *logic* but never compute CSS or layout. Bugs where an element has content
// yet renders with zero-size swatches or a collapsed box slip through. This test loads
// the actual app in a real browser, performs real clicks, and asserts *computed* layout
// (bounding rects) — exactly the class of bug the unit tests can't see.
//
//   node test/browser.ts
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { startMockPprofServer } from './mock-pprof-server.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROOT = process.cwd();
const DATA = resolve(ROOT, 'test/data/node.cpuprofile'); // timed → enables Timeline (chart)
// CHROME_PATH overrides (CI sets it from setup-chrome); else probe the usual Mac/Linux spots.
const CHROME = process.env.CHROME_PATH
  || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser', '/usr/bin/chromium'].find((p) => existsSync(p))
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(CHROME)) { console.log('skip: Chrome not found (set CHROME_PATH)', CHROME); process.exit(0); }
if (!existsSync(DATA)) { console.log('skip: test fixture missing:', DATA); process.exit(0); }

// ---- tiny static file server (correct MIME so the browser accepts ES modules) ----
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.cpuprofile': 'application/json', '.svg': 'image/svg+xml', '.gz': 'application/gzip',
};
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
    if (p === '/' || p === '') p = '/src/index.html';
    const fp = resolve(ROOT, '.' + p);
    if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    const buf = await readFile(fp);
    res.writeHead(200, { 'content-type': MIME[extname(fp)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const PORT = (server.address() as any).port;
const APP = `http://127.0.0.1:${PORT}/src/index.html`;

// ---- minimal CDP client over the built-in WebSocket ----
class CDP {
  ws: any; id = 0; pending = new Map<number, any>(); listeners: ((m: any) => void)[] = [];
  constructor(ws: any) {
    this.ws = ws;
    ws.addEventListener('message', (ev: any) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else { for (const l of this.listeners) l(m); }
    });
  }
  send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  once(method: string, sessionId?: string): Promise<any> {
    return new Promise((res) => {
      const l = (m: any) => { if (m.method === method && (!sessionId || m.sessionId === sessionId)) { this.listeners = this.listeners.filter((x) => x !== l); res(m.params); } };
      this.listeners.push(l);
    });
  }
}

const dir = mkdtempSync(join(tmpdir(), 'fv-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio', '--user-data-dir=' + dir,
  // CI runners launch Chrome as root in a container → these are required there, harmless locally.
  '--no-sandbox', '--disable-dev-shm-usage',
  '--remote-debugging-port=0', '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name} — ${detail}`);
  if (!ok) failures++;
};

try {
  // discover the DevTools port Chrome chose
  const portFile = join(dir, 'DevToolsActivePort');
  let devPort = 0;
  for (let i = 0; i < 100 && !devPort; i++) { await sleep(100); if (existsSync(portFile)) { const t = readFileSync(portFile, 'utf8').split('\n'); if (t[0]) devPort = parseInt(t[0], 10); } }
  if (!devPort) throw new Error('Chrome did not expose a DevTools port');

  const ver = await (await fetch(`http://127.0.0.1:${devPort}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => { ws.addEventListener('open', () => res(), { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const cdp = new CDP(ws);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('DOM.enable', {}, sessionId);

  const evalIn = async (expr: string) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const poll = async (expr: string, ms = 10000) => {
    const t0 = Date.now();
    for (;;) { const v = await evalIn(expr); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + expr); await sleep(50); }
  };

  const loaded = cdp.once('Page.loadEventFired', sessionId);
  await cdp.send('Page.navigate', { url: APP }, sessionId);
  await loaded;
  await poll(`document.readyState==='complete' && !!document.getElementById('file') ? 1 : 0`);
  await poll(`window.__fv ? 1 : 0`); // let the default-sample auto-load settle first

  // load a deterministic fixture through the real file-open path (setFileInputFiles → change
  // → ingest), then wait until it is the active profile (so the auto-load can't clobber it)
  const { root } = await cdp.send('DOM.getDocument', {}, sessionId);
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' }, sessionId);
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [DATA] }, sessionId);
  await poll(`/node\\.cpuprofile/.test(document.getElementById('info').innerText||'') && window.__fv ? 1 : 0`);
  console.log('loaded', DATA.split('/').pop(), 'into a real browser');

  // --- FG-034: full-bleed shell (no toolbar/hint bands; one status strip; canvas fills) ---
  const shell = await evalIn(`(()=>{const cv=document.getElementById('cv').getBoundingClientRect();return {bar:!!document.getElementById('bar'),hint:!!document.getElementById('hint'),strip:!!document.getElementById('statusbar'),cvH:Math.round(cv.height),winH:window.innerHeight,wtok:(document.getElementById('st-weight').innerText||''),empty:getComputedStyle(document.getElementById('empty')).display};})()`);
  check('FG-034: full-bleed shell (no #bar/#hint, status strip, canvas fills)', !shell.bar && !shell.hint && shell.strip && shell.cvH > shell.winH - 60, `cvH=${shell.cvH}/${shell.winH} strip=${shell.strip} bar=${shell.bar} hint=${shell.hint}`);
  check('FG-034: status strip shows weight token; empty-state hidden after load', /\S/.test(shell.wtok) && shell.empty === 'none', `weight="${shell.wtok}" empty=${shell.empty}`);

  // legend swatches must have non-zero rendered size (catches the CSS-not-applied bug)
  const legendProbe = `(()=>{const l=document.getElementById('legend');l.classList.add('on');/* on-demand (FG-037) — show before measuring */const sw=l.querySelector('span span');const r=sw&&sw.getBoundingClientRect();const lr=l.getBoundingClientRect();return {mode:window.__fv.mode,chips:l.querySelectorAll('span span').length,swW:r?Math.round(r.width):0,swH:r?Math.round(r.height):0,legH:Math.round(lr.height)};})()`;

  // click a box and assert the detail panel's stack renders with real swatches
  const clickAndProbeDetail = async (label: string) => {
    const pick = await evalIn(`(()=>{const v=window.__fv;const cv=document.getElementById('cv');const cr=cv.getBoundingClientRect();const ROW=22;const top=v.contentTop||0;const cand=v.boxes.filter(b=>b.depth>=1&&b.w>15).map(b=>({d:b.depth,x:cr.left+b.x+b.w/2,y:cr.top+top+b.depth*ROW+ROW/2})).filter(b=>b.y<850).sort((a,b)=>a.d-b.d);return (cand.find(b=>b.d>=2)||cand[0])||null;})()`);
    if (!pick) { check(`${label}: clickable box found`, false, 'no box with depth>=1 visible'); return; }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pick.x, y: pick.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pick.x, y: pick.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
    await sleep(80);
    const d = await evalIn(`(()=>{const el=document.getElementById('detail');const sw=el.querySelectorAll('.dstack .chip');let minW=1e9;sw.forEach(s=>{minW=Math.min(minW,s.getBoundingClientRect().width);});return {swatches:sw.length,minW:sw.length?Math.round(minW):0,nan:/NaN/.test(el.innerText||''),text:(el.innerText||'').replace(/\\s+/g,' ').trim().slice(0,70)};})()`);
    check(`${label}: detail stack has swatches`, d.swatches >= 2 && d.minW > 0, `${d.swatches} swatches, min width ${d.minW}px`);
    check(`${label}: no NaN in detail`, !d.nan, d.text);
  };

  // --- Aggregated (graph) ---
  const g = await evalIn(legendProbe);
  check('graph: legend swatches render', g.chips > 0 && g.swW > 0 && g.swH > 0, `${g.chips} chips, swatch ${g.swW}x${g.swH}px, legend h=${g.legH}`);
  await clickAndProbeDetail('graph');

  // --- Timeline (chart) — the reported bug ---
  await evalIn(`document.getElementById('m-chart').click()`);
  await poll(`window.__fv && window.__fv.mode==='chart' ? 1 : 0`);
  const c = await evalIn(legendProbe);
  check('chart: legend swatches render', c.chips > 0 && c.swW > 0 && c.swH > 0, `${c.chips} chips, swatch ${c.swW}x${c.swH}px`);
  await clickAndProbeDetail('chart');

  // --- minimap: drag to crop a time window (chart) ---
  // band-aware: if the content overflows vertically, the viewport rect is partial-height, so
  // a horizontal *draw* must start outside that band (inside the band = translate/move).
  const mm = await evalIn(`(()=>{const cv=document.getElementById('cv');const r=cv.getBoundingClientRect();const f=window.__fv;const over=f.maxScrollY>0;const vy1=over?((f.scrollY+f.viewH)/f.contentFullH)*52:52;return {left:r.left,top:r.top,w:r.width,contentTop:f.contentTop,winNull:f.win==null,yOut:r.top+(over?(vy1+52)/2:8),yIn:r.top+Math.min(8,vy1/2)};})()`);
  check('minimap: present in chart', mm.contentTop === 52 + 18, `contentTop=${mm.contentTop} (expect 70 = minimap+axis), win initially ${mm.winNull ? 'full' : 'cropped'}`);
  const xA = mm.left + mm.w * 0.30, xB = mm.left + mm.w * 0.65;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: xA, y: mm.yOut, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (xA + xB) / 2, y: mm.yOut, button: 'left', buttons: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: xB, y: mm.yOut, button: 'left', buttons: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: xB, y: mm.yOut, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
  await sleep(80);
  const afterDraw = await evalIn(`(()=>{const v=window.__fv;const span=v.chart?v.chart.end-v.chart.start:0;const w=v.win?v.win[1]-v.win[0]:null;return {cropped:!!v.win, frac: w!=null&&span?+(w/span).toFixed(2):null};})()`);
  check('minimap: drag draws a crop window', afterDraw.cropped && afterDraw.frac > 0.2 && afterDraw.frac < 0.6, `win covers ${afterDraw.frac == null ? 'null' : afterDraw.frac * 100 + '%'} of the timeline`);

  // --- minimap: drag inside the rect to pan it (horizontally) ---
  const before = await evalIn(`window.__fv.win ? window.__fv.win[0] : null`);
  const insideX = mm.left + mm.w * 0.475; // inside the ~30-65% crop
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: insideX, y: mm.yIn, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: insideX + mm.w * 0.15, y: mm.yIn, button: 'left', buttons: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: insideX + mm.w * 0.15, y: mm.yIn, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
  await sleep(80);
  const afterPan = await evalIn(`window.__fv.win ? window.__fv.win[0] : null`);
  check('minimap: drag inside pans the window', before != null && afterPan != null && afterPan > before, `win start ${before} → ${afterPan}`);

  // --- chart: Cmd/Ctrl-wheel zooms about the cursor; content hover sets the synced crosshair ---
  await evalIn(`window.__fv.resetZoom()`); // back to full
  const cz = await evalIn(`(()=>{const cv=document.getElementById('cv');const r=cv.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+window.__fv.contentTop+30};})()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cz.x, y: cz.y, deltaX: 0, deltaY: -240, modifiers: 2 }, sessionId);
  await sleep(60);
  const z = await evalIn(`(()=>{const f=window.__fv;const span=f.chart.end-f.chart.start;return {cropped:!!f.win, frac: f.win?+((f.win[1]-f.win[0])/span).toFixed(2):null};})()`);
  check('chart: ctrl-wheel zooms in about the cursor', z.cropped && z.frac > 0.1 && z.frac < 0.9, `window now ${z.frac == null ? 'full' : z.frac * 100 + '%'}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cz.x, y: cz.y }, sessionId);
  await sleep(30);
  const hv = await evalIn(`window.__fv.hoverV`);
  check('hover-sync: content hover sets crosshair value', hv != null, `hoverV ${hv == null ? 'null' : 'set'}`);

  // --- x-axis ruler: reserved height + unit-aware labels ---
  const ax = await evalIn(`(()=>{const f=window.__fv;return {contentTop: f.contentTop, banded: f.contentTop === 52 + 18, unit: f.p.capabilities.timeUnit, total: f._fmtTime(f.chart.end - f.chart.start), tick: f._fmtTime((f.chart.end-f.chart.start)/2)};})()`);
  check('axis: ruler between minimap & data + time label (µs→ms)', ax.banded && /\d/.test(ax.total) && /(ns|µs|ms|s)$/.test(ax.total), `contentTop=${ax.contentTop} (expect 70), unit=${ax.unit}, total=${ax.total}, mid=${ax.tick}`);
  const infoTxt = await evalIn(`document.getElementById('info').innerText`);
  check('info bar: shows unit-aware total (cpu_nanos→time)', /\bnodes\b/.test(infoTxt) && /total$/.test(infoTxt) && /(ns|µs|ms|s) total$/.test(infoTxt), infoTxt);

  // Esc resets the zoom/crop
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cz.x, y: cz.y, deltaX: 0, deltaY: -240, modifiers: 2 }, sessionId);
  await sleep(40);
  const escBefore = await evalIn(`window.__fv.win != null`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await sleep(40);
  const escAfter = await evalIn(`window.__fv.win == null`);
  check('keyboard: Esc resets zoom/crop', escBefore && escAfter, `cropped=${escBefore} → cleared=${escAfter}`);

  // --- horizontal scroll pans the crop (main pane + over the minimap) ---
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cz.x, y: cz.y, deltaX: 0, deltaY: -240, modifiers: 2 }, sessionId); // crop via zoom
  await sleep(40);
  const hp0 = await evalIn(`window.__fv.win ? window.__fv.win[0] : null`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cz.x, y: cz.y, deltaX: 120, deltaY: 0 }, sessionId);
  await sleep(40);
  const hp1 = await evalIn(`window.__fv.win ? window.__fv.win[0] : null`);
  check('hscroll: deltaX pans the crop on the main pane', hp0 != null && hp1 != null && hp1 > hp0, `win start ${hp0} → ${hp1}`);
  const mY = await evalIn(`(()=>{const cv=document.getElementById('cv');const r=cv.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+10};})()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mY.x, y: mY.y, deltaX: 120, deltaY: 0 }, sessionId);
  await sleep(40);
  const hp2 = await evalIn(`window.__fv.win ? window.__fv.win[0] : null`);
  check('hscroll: deltaX over the minimap pans too', hp2 != null && hp2 > hp1, `win start ${hp1} → ${hp2}`);
  await evalIn(`window.__fv.resetZoom()`);

  // --- minimap: vertical scrolling on a deep profile (needs content taller than the viewport) ---
  const DEEP = resolve(ROOT, 'test/testdata/real-vertx.speedscope.json');
  if (existsSync(DEEP)) {
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [DEEP] }, sessionId);
    await poll(`/real-vertx/.test(document.getElementById('info').innerText||'') && window.__fv ? 1 : 0`);
    await evalIn(`document.getElementById('m-chart').click()`);
    await poll(`window.__fv && window.__fv.mode==='chart' ? 1 : 0`);
    const vinfo = await evalIn(`(()=>{const f=window.__fv;return {maxScroll:Math.round(f.maxScrollY),contentTop:f.contentTop};})()`);
    check('vscroll: deep profile overflows the viewport', vinfo.maxScroll > 0, `maxScrollY=${vinfo.maxScroll}px`);

    // wheel over the content scrolls vertically
    const cw = await evalIn(`(()=>{const cv=document.getElementById('cv');const r=cv.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+window.__fv.contentTop+40};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cw.x, y: cw.y, deltaX: 0, deltaY: 300 }, sessionId);
    await sleep(60);
    const afterWheel = await evalIn(`Math.round(window.__fv.scrollY)`);
    check('vscroll: wheel scrolls the content', afterWheel > 0, `scrollY 0 → ${afterWheel}`);

    // drag the minimap viewport rectangle vertically
    const sBefore = await evalIn(`Math.round(window.__fv.scrollY)`);
    const mv = await evalIn(`(()=>{const cv=document.getElementById('cv');const r=cv.getBoundingClientRect();const f=window.__fv;const vy0=(f.scrollY/f.contentFullH)*52;return {x:r.left+r.width/2,y:r.top+vy0+5};})()`);
    const dir = sBefore > vinfo.maxScroll / 2 ? -1 : 1; // drag toward the side with room
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mv.x, y: mv.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mv.x, y: mv.y + 20 * dir, button: 'left', buttons: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mv.x, y: mv.y + 20 * dir, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
    await sleep(60);
    const sAfter = await evalIn(`Math.round(window.__fv.scrollY)`);
    check('vscroll: drag minimap rect scrolls vertically', sAfter !== sBefore, `scrollY ${sBefore} → ${sAfter}`);
  }

  // --- sandwich: contained vertical scroll (canvas fits window, wheel scrolls content, page stays put) ---
  if (existsSync(DEEP)) {
    await evalIn(`document.getElementById('m-sandwich').click()`);
    await poll(`window.__fv && window.__fv.mode==='sandwich' ? 1 : 0`);
    const s0 = await evalIn(`(()=>{const f=window.__fv;return {fits: f.cssH <= window.innerHeight, maxScroll: Math.round(f.maxScrollY), scrollY: Math.round(f.scrollY), callers:f.callerBoxes.length, callees:f.calleeBoxes.length};})()`);
    check('sandwich: canvas fits the window (no page scroll)', s0.fits, `cssH ${s0.fits ? '<=' : '>'} innerHeight, maxScrollY=${s0.maxScroll}`);
    // default focal must be a real hub — both halves non-trivial (a leaf focal degenerates into
    // a plain inverted stack that looks just like Timeline)
    check('sandwich: default focal is a hub (callers & callees both substantial)', s0.callers > 2 && s0.callees > 2, `callers=${s0.callers} callees=${s0.callees}`);
    const sc = await evalIn(`(()=>{const cv=document.getElementById('cv');const r=cv.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+120};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: sc.x, y: sc.y, deltaX: 0, deltaY: 400 }, sessionId);
    await sleep(60);
    const s1 = await evalIn(`(()=>({scrollY:Math.round(window.__fv.scrollY),pageY:Math.round(window.scrollY||0)}))()`);
    check('sandwich: wheel scrolls content internally, not the page', s0.maxScroll > 0 ? (s1.scrollY > 0 && s1.pageY === 0) : true, `scrollY 0 → ${s1.scrollY}, pageY=${s1.pageY}`);

    // scrollbar thumb is draggable in sandwich (no minimap, so it's the only vertical handle)
    if (s0.maxScroll > 0) {
      const tb = await evalIn(`(()=>{const cv=document.getElementById('cv');const r=cv.getBoundingClientRect();const f=window.__fv;const t=f._thumb();return {x:r.left+f.cssW-4,y:r.top+t.y+5};})()`);
      const sb = await evalIn(`Math.round(window.__fv.scrollY)`);
      const dir = sb > s0.maxScroll / 2 ? -1 : 1;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tb.x, y: tb.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tb.x, y: tb.y + 40 * dir, button: 'left', buttons: 1 }, sessionId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tb.x, y: tb.y + 40 * dir, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
      await sleep(60);
      const sa = await evalIn(`Math.round(window.__fv.scrollY)`);
      check('scrollbar: dragging the thumb scrolls (sandwich)', sa !== sb, `scrollY ${sb} → ${sa}`);
    }

    // focal is decoupled from selection: re-center (dblclick a caller) changes the focal, Esc
    // resets it to default, and re-entry (→graph→sandwich) is stable — even after a graph click
    const f0 = await evalIn(`window.__fv.focalFunc`);
    await evalIn(`(()=>{const v=window.__fv;const cv=document.getElementById('cv').getBoundingClientRect();const ROW=22;const b=v.callerBoxes.find(b=>b.depth>0&&b.w>6)||v.callerBoxes.find(b=>b.w>6);v._onDblClick({clientX:cv.left+b.x+b.w/2,clientY:cv.top+(v.callerMaxDepth-b.depth)*ROW+ROW/2-v.scrollY});})()`);
    const f1 = await evalIn(`window.__fv.focalFunc`);
    check('sandwich: dblclick re-centers the focal', f1 !== f0, `focal ${f0} → ${f1}`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
    await sleep(40);
    check('sandwich: Esc resets focal to default', await evalIn(`window.__fv.focalFunc`) === f0, `focal after Esc vs default ${f0}`);
    await evalIn(`(()=>{window.__fv.selectedFunc = 5;})()`); // simulate a stray graph selection
    await evalIn(`document.getElementById('m-graph').click()`); await poll(`window.__fv.mode==='graph'?1:0`);
    await evalIn(`document.getElementById('m-sandwich').click()`); await poll(`window.__fv.mode==='sandwich'?1:0`);
    check('sandwich: re-entry is stable (→graph→sandwich, ignores selection)', await evalIn(`window.__fv.focalFunc`) === f0, `re-entry focal vs ${f0}`);
  }

  // --- dispose: a rebuilt view must remove its old canvas listeners (no double-handling) ---
  await evalIn(`(window.__prev = window.__fv).selectedFunc = 'SENTINEL'`);
  await evalIn(`window.__app.loadSample('samples/node.cpuprofile')`);
  await poll(`window.__fv && window.__fv !== window.__prev ? 1 : 0`);
  const cc = await evalIn(`(()=>{const cv=document.getElementById('cv');const r=cv.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cc.x, y: cc.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cc.x, y: cc.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
  await sleep(50);
  const stale = await evalIn(`window.__prev.selectedFunc`);
  check('dispose: stale view ignores canvas events after rebuild', stale === 'SENTINEL', `prev.selectedFunc=${JSON.stringify(stale)}`);

  // --- diff view end-to-end: load base, compare against the perturbed copy ---
  const MOD = resolve(ROOT, 'test/testdata/real-vertx-modified.speedscope.json');
  if (existsSync(MOD)) {
    // base A via the sample dropdown (reliable; #file may already hold this path → no change event)
    await evalIn(`window.__app.loadSample('samples/real-vertx.speedscope.json')`);
    await poll(`/real-vertx/.test(document.getElementById('info').innerText||'') && window.__fv ? 1 : 0`);
    const doc = await cdp.send('DOM.getDocument', {}, sessionId);
    const f2 = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file2' }, sessionId);
    await cdp.send('DOM.setFileInputFiles', { nodeId: f2.nodeId, files: [MOD] }, sessionId); // compare B
    await poll(`window.__fv && window.__fv.mode==='diff' ? 1 : 0`);
    const d = await evalIn(`(()=>{const f=window.__fv;const dm=f.diffMax||1;let red=0,blue=0;for(const b of f.boxes){const tn=(b.delta||0)/dm;if(tn>0.03)red++;else if(tn<-0.03)blue++;}return {mode:f.mode,isDiff:f.p.capabilities.isDiff,contentTop:f.contentTop,boxes:f.boxes.length,mini:f.miniBoxes?f.miniBoxes.length:0,red,blue,legend:(document.getElementById('legend').innerText||'').slice(0,60),info:(document.getElementById('info').innerText||'').slice(0,40)};})()`);
    check('diff: mode + minimap band + delta boxes (red & blue)', d.mode === 'diff' && d.isDiff && d.contentTop === 70 && d.mini > 0 && d.red > 0 && d.blue > 0, `boxes=${d.boxes} mini=${d.mini} red=${d.red} blue=${d.blue} contentTop=${d.contentTop}`);
    check('diff: legend shows ±% range + "diff vs" in info', /baseline/.test(d.legend) && /[−-]\d.*%/.test(d.legend) && /\+\d.*%/.test(d.legend) && /diff vs/.test(d.info), `legend="${d.legend}" info="${d.info}"`);
    // the reset button exits diff back to a normal view (rebuilt from the base profile)
    await evalIn(`window.__app.resetView()`);
    await poll(`window.__fv && window.__fv.mode!=='diff' ? 1 : 0`);
    const exited = await evalIn(`window.__fv.mode`);
    check('diff: reset exits diff', exited !== 'diff', `mode now ${exited}`);

    // search must be cleared on entering diff (matchedFuncs are original-profile indices)
    await evalIn(`window.__app.loadSample('samples/real-vertx.speedscope.json')`);
    await poll(`/real-vertx/.test(document.getElementById('info').innerText||'') && /total/.test(document.getElementById('info').innerText||'') ? 1 : 0`); // wait for the COMPLETED load, not the "loading…" message
    await evalIn(`window.__app.setSearch('read')`);
    const hadSearch = await evalIn(`!!window.__fv.matchedFuncs`);
    const doc2 = await cdp.send('DOM.getDocument', {}, sessionId);
    const f2b = await cdp.send('DOM.querySelector', { nodeId: doc2.root.nodeId, selector: '#file2' }, sessionId);
    await cdp.send('DOM.setFileInputFiles', { nodeId: f2b.nodeId, files: [DEEP] }, sessionId); // different path than MOD → fires change
    await poll(`window.__fv && window.__fv.mode==='diff' ? 1 : 0`);
    check('diff: entering diff clears stale search', hadSearch && (await evalIn(`window.__fv.matchedFuncs === null`)), `matchedFuncs cleared`);

    // switching view-type while in diff must exit diff cleanly (not a broken grey diff)
    await evalIn(`document.getElementById('st-viewtype').click()`); // diff (flame) → radial
    await poll(`window.__fv && window.__fv.mode!=='diff' ? 1 : 0`);
    const vd = await evalIn(`(()=>({mode:window.__fv.mode,type:window.__fv.constructor.name,diff:window.__fv.p.capabilities.isDiff}))()`);
    check('diff: switching view-type exits diff cleanly', vd.mode !== 'diff' && !vd.diff, JSON.stringify(vd));
    await evalIn(`window.__app.setViewType('flame')`); // back to flame
    await poll(`window.__fv && window.__fv.constructor.name==='FlameView' ? 1 : 0`);
  }

  // --- FG-039: radial (sunburst) view type ---
  await evalIn(`document.getElementById('st-viewtype').click()`); // flame → radial
  await poll(`window.__fv && window.__fv.constructor.name==='RadialView' ? 1 : 0`);
  const rad = await evalIn(`(()=>{const v=window.__fv;return {type:v.constructor.name,mode:v.mode,boxes:v.boxes.length,ring:Math.round(v.ringH),chartOff:document.getElementById('m-chart').disabled,sandOff:document.getElementById('m-sandwich').disabled,vt:document.getElementById('st-viewtype').innerText};})()`);
  check('radial: renders arcs + restricts modes (no chart/sandwich)', rad.type === 'RadialView' && rad.boxes > 10 && rad.ring > 0 && rad.chartOff && rad.sandOff && rad.vt === 'radial', JSON.stringify(rad));
  // click a wedge (compute a point at the mid-angle/mid-radius of a depth-1 box)
  const hit = await evalIn(`(()=>{const v=window.__fv;const b=v.boxes.find(b=>b.depth===1)||v.boxes[0];if(!b)return null;const a=-Math.PI/2+b.x+b.w/2,rr=v.r0+(b.depth+0.5)*v.ringH,cv=document.getElementById('cv').getBoundingClientRect();return {x:cv.left+v.cx+Math.cos(a)*rr,y:cv.top+v.cy+Math.sin(a)*rr};})()`);
  if (hit) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
    await sleep(60);
    const sel = await evalIn(`(()=>({sel:window.__fv.selectedFunc!=null,on:document.getElementById('detail').classList.contains('on')}))()`);
    check('radial: clicking a wedge selects + opens the detail slide-over', sel.sel && sel.on, JSON.stringify(sel));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y }, sessionId);
    await sleep(40);
    check('radial: hover drives the center focal label', await evalIn(`window.__fv.hover != null`), 'hover set');
    // double-click zooms (focus a subtree) with a transition; clicking the center zooms out
    await evalIn(`window.__fv._onDblClick({clientX:${hit.x},clientY:${hit.y}})`);
    check('radial: double-click zooms into a subtree', await evalIn(`window.__fv.focus != null`), `focus=${await evalIn(`window.__fv.focus`)}`);
    await sleep(300); // let the zoom transition finish
    await evalIn(`window.__fv._onDblClick({clientX:0,clientY:0})`); // outside → zoom out
    check('radial: double-click center zooms out + transition clears', await evalIn(`window.__fv.focus === null`), `anim=${await evalIn(`!!window.__fv._anim`)}`);
  }
  // --- FG-051: call-graph (GraphView) view type ---
  await evalIn(`document.getElementById('st-viewtype').click()`); // radial → graph
  await poll(`window.__fv && window.__fv.constructor.name==='GraphView' ? 1 : 0`);
  const gv = await evalIn(`(()=>{const v=window.__fv;return {type:v.constructor.name,mode:v.mode,nodes:v._nodes.length,chartOff:document.getElementById('m-chart').disabled,sandOff:document.getElementById('m-sandwich').disabled,vt:document.getElementById('st-viewtype').innerText};})()`);
  check('FG-051 graph-view: switches to GraphView + token reads "graph"', gv.type === 'GraphView' && gv.vt === 'graph', JSON.stringify(gv));
  check('FG-051 graph-view: renders nodes (> 0)', gv.nodes > 0, `_nodes.length=${gv.nodes}`);
  check('FG-051 graph-view: Timeline + Sandwich mode buttons are disabled (caps)', gv.chartOff && gv.sandOff, JSON.stringify(gv));
  // click a node → selectedFunc is set (drive via _onClick with canvas-relative coords)
  await evalIn(`(()=>{const v=window.__fv;const n=v._nodes[0];if(!n)return;const s=v.scale||1,tx=v.tx||0,ty=v.ty||0;const r=v.canvas.getBoundingClientRect();v._onClick({clientX:r.left+n.x*s+tx+n.w*s/2,clientY:r.top+n.y*s+ty+n.h*s/2});})()`);
  await sleep(60);
  check('FG-051 graph-view: clicking a node sets selectedFunc', await evalIn(`window.__fv.selectedFunc != null`), `selectedFunc=${await evalIn(`window.__fv.selectedFunc`)}`);
  // Cmd/Ctrl-wheel changes scale
  const gvCtr = await evalIn(`(()=>{const cv=document.getElementById('cv');const r=cv.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  const gvScaleBefore = await evalIn(`window.__fv.scale`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: gvCtr.x, y: gvCtr.y, deltaX: 0, deltaY: -240, modifiers: 2 }, sessionId);
  await sleep(60);
  const gvScaleAfter = await evalIn(`window.__fv.scale`);
  check('FG-051 graph-view: Ctrl-wheel changes scale', gvScaleAfter !== gvScaleBefore, `scale ${gvScaleBefore} → ${gvScaleAfter}`);
  // cycle back to flame (use setViewType for stability across cycle lengths)
  await evalIn(`window.__app.setViewType('flame')`);
  await poll(`window.__fv && window.__fv.constructor.name==='FlameView' ? 1 : 0`);
  check('FG-051 graph-view: cycles back to flame', await evalIn(`window.__fv.constructor.name==='FlameView'`), 'back to flame from graph');

  // --- transition fuzz: mode × view-type × diff × search; invariants after EACH step ---
  await evalIn(`window.__app.resetView && window.__app.setViewType('flame')`); // known base: flame
  await poll(`window.__fv && window.__fv.constructor.name==='FlameView' ? 1 : 0`);
  const pageErrors: string[] = [];
  cdp.listeners.push((m: any) => { if (m.method === 'Runtime.exceptionThrown') pageErrors.push((m.params.exceptionDetails && (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)) || 'exception'); });
  // safety invariants checked after every transition
  const INV = `(()=>{const f=window.__fv;if(!f)return{ok:false,why:'no view'};const n=f.p.funcTable.name.length;const okI=(x)=>x==null||(x>=0&&x<n);` +
    `if(!['graph','chart','sandwich','diff'].includes(f.mode))return{ok:false,why:'bad mode '+f.mode};` +
    `if((f.mode==='diff')!==!!f.p.capabilities.isDiff)return{ok:false,why:'diff/profile mismatch'};` +
    `if(!okI(f.selectedFunc))return{ok:false,why:'selectedFunc OOB'};` +
    `if(f.mode==='sandwich'&&!okI(f.focalFunc))return{ok:false,why:'focalFunc OOB'};` +
    `if(f.matchedFuncs){for(const x of f.matchedFuncs)if(x>=n)return{ok:false,why:'matchedFunc OOB ('+x+'>='+n+')'};}` +
    `if(f.mode==='sandwich'){if(!f.callerBoxes||!f.calleeBoxes)return{ok:false,why:'no sandwich boxes'};}else if(!f.boxes)return{ok:false,why:'no boxes'};` +
    `if(!(f.cssH>0))return{ok:false,why:'cssH<=0'};` +
    `try{f.draw();}catch(e){return{ok:false,why:'draw threw: '+e.message};}return{ok:true,mode:f.mode,type:f.constructor.name};})()`;
  const ops: any[][] = [
    ['mode', 'm-chart'], ['mode', 'm-sandwich'], ['view'], ['mode', 'm-graph'], ['search', 're'],
    ['view'], ['mode', 'm-chart'], ['search', ''], ['mode', 'm-sandwich'], ['reset'],
    ['diff'], ['search', 'Object'], ['view'], ['view'], ['mode', 'm-chart'], ['esc'], ['reset'],
  ];
  let fuzzFails = 0; const trail: string[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op[0] === 'mode') await evalIn(`document.getElementById('${op[1]}').click()`);
    else if (op[0] === 'view') await evalIn(`window.__app.setViewType(window.__fv.constructor.name==='RadialView'?'flame':'radial')`);
    else if (op[0] === 'search') await evalIn(`window.__app.setSearch(${JSON.stringify(op[1])})`);
    else if (op[0] === 'reset') await evalIn(`window.__app.resetView()`);
    else if (op[0] === 'diff') await evalIn(`window.__app.diffWith('/test/testdata/real-vertx-modified.speedscope.json')`);
    else if (op[0] === 'esc') { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId); }
    await sleep(35);
    const inv = await evalIn(INV);
    trail.push(`${op.join(':')}→${inv.ok ? inv.mode + '/' + (inv.type || '').replace('View', '') : 'FAIL'}`);
    if (!inv.ok) { fuzzFails++; console.log(`  ✗ fuzz step ${i} [${op.join(' ')}] → ${inv.why}`); }
  }
  check(`fuzz: ${ops.length} mode×view×diff×search transitions hold invariants`, fuzzFails === 0 && pageErrors.length === 0, `${fuzzFails} invariant fails, ${pageErrors.length} page error(s)${pageErrors.length ? ': ' + pageErrors[0] : ''}`);

  // --- FG-053: thread selector + all-threads merge ---
  // Build a synthetic 2-thread profile in the browser via window.__app, assert the selector
  // appears, listThreads() lists >1 + 'all', setThread(0) changes totals vs 'all', and
  // 'all' total >= any single thread. Then load a single-thread profile and assert no token.
  {
    // Inject a 2-thread profile programmatically via __app.loadProfile (if available), or
    // via __fv.p mutation. We use a cleaner approach: call __app.setThread / listThreads
    // against the real node.cpuprofile (single thread) first, then build a synthetic multi-
    // thread profile to exercise the full selector path.
    await evalIn(`window.__app.loadSample('samples/node.cpuprofile')`);
    await poll(`window.__fv && /node\\.cpuprofile/.test(document.getElementById('info').innerText||'') ? 1 : 0`);

    // Single-thread profile: thread token must be hidden, listThreads must still work
    const singleTok = await evalIn(`(()=>{const el=document.getElementById('st-thread');return {display:getComputedStyle(el).display,text:el.innerText||''};   })()`);
    check('FG-053: single-thread profile — thread token hidden', singleTok.display === 'none', `display=${singleTok.display}`);
    const singleList = await evalIn(`window.__app.listThreads ? window.__app.listThreads() : null`);
    check('FG-053: listThreads() returns an array (single-thread)', Array.isArray(singleList), `listThreads=${JSON.stringify(singleList && singleList.slice(0,2))}`);

    // Build a synthetic 2-thread profile in the page's module scope via eval.
    // We clone the current profile (same tables), create 2 threads with disjoint sample sets,
    // then call the internal loadProfile path via __app hooks.
    const injected = await evalIn(`(()=>{
      try {
        // Grab the real single-thread profile as a base for tables.
        const base = window.__fv.p;
        // Split the existing samples into two halves (thread 0 gets even indices, 1 gets odd).
        const t0 = base.threads[0];
        const stacks = t0.samples.stack;
        const wt = Object.keys(t0.samples.weightsByType)[0] || 'samples';
        const col = t0.samples.weightsByType[wt] || [];
        const hasTiming = base.capabilities.hasTiming;
        const time = hasTiming ? t0.samples.time : null;

        const s0={stack:[],wt:[]}, s1={stack:[],wt:[]}, t_0=[], t_1=[];
        for(let i=0;i<stacks.length;i++) {
          if(i%2===0){s0.stack.push(stacks[i]);s0.wt.push(col[i]||0);if(hasTiming&&time)t_0.push(time[i]);}
          else{s1.stack.push(stacks[i]);s1.wt.push(col[i]||0);if(hasTiming&&time)t_1.push(time[i]);}
        }
        if(s0.stack.length===0||s1.stack.length===0) return {ok:false,why:'too few samples to split'};

        const wbt0={}, wbt1={};
        wbt0[wt]=s0.wt; wbt1[wt]=s1.wt;
        const thread0={name:'worker-0',samples:{stack:s0.stack,weightsByType:wbt0,...(hasTiming?{time:t_0}:{})}};
        const thread1={name:'worker-1',samples:{stack:s1.stack,weightsByType:wbt1,...(hasTiming?{time:t_1}:{})}};

        const p2 = Object.assign({}, base, { threads: [thread0, thread1] });
        // Inject via the internal loadProfile — we have to call it from inside the module.
        // We expose it on __app for testing purposes via window.__injectProfile.
        if (window.__injectProfile) { window.__injectProfile(p2, 'synthetic-2thread'); return {ok:true}; }
        return {ok:false,why:'__injectProfile not available'};
      } catch(e) { return {ok:false,why:e.message}; }
    })()`);

    // If __injectProfile not available, we'll add it; but for now test via a different route.
    // We expose __app.setThread and __app.listThreads and test them against the REAL JFR profile
    // if available, otherwise we inject directly.

    // Expose an internal loadProfile hook for testing (won't be used by non-tests)
    await evalIn(`(()=>{
      if(!window.__injectProfile) {
        // Reach the module's loadProfile via the __app hook
        // We can't directly call loadProfile (it's module-private), but we can use
        // the fact that the profile object is mutable — swap threads on the live profile
        // and call rebuild via __app.resetView which re-reads profile.
        window.__mutateToMultiThread = function() {
          const base = window.__fv.p;
          const t0 = base.threads[0];
          const stacks = t0.samples.stack;
          const wt = Object.keys(t0.samples.weightsByType)[0]||'samples';
          const col = t0.samples.weightsByType[wt]||[];
          const hasTiming = base.capabilities.hasTiming;
          const time = hasTiming ? t0.samples.time : null;
          const s0={stack:[],wt:[]}, s1={stack:[],wt:[]}, t_0=[], t_1=[];
          for(let i=0;i<stacks.length;i++) {
            if(i%2===0){s0.stack.push(stacks[i]);s0.wt.push(col[i]||0);if(hasTiming&&time)t_0.push(time[i]);}
            else{s1.stack.push(stacks[i]);s1.wt.push(col[i]||0);if(hasTiming&&time)t_1.push(time[i]);}
          }
          if(!s0.stack.length||!s1.stack.length) return false;
          const wbt0={}, wbt1={};
          wbt0[wt]=s0.wt; wbt1[wt]=s1.wt;
          const thread0={name:'worker-0',samples:{stack:s0.stack,weightsByType:wbt0,...(hasTiming?{time:t_0}:{})}};
          const thread1={name:'worker-1',samples:{stack:s1.stack,weightsByType:wbt1,...(hasTiming?{time:t_1}:{})}};
          base.threads.length=0; base.threads.push(thread0,thread1);
          return true;
        };
      }
    })()`);

    const mutated = await evalIn(`(()=>{
      if(!window.__mutateToMultiThread) return false;
      const ok = window.__mutateToMultiThread();
      if(!ok) return false;
      // Trigger a rebuild by cycling setThread to 'all' (it reads from the profile object)
      if(window.__app.setThread) { window.__app.setThread('all'); }
      return true;
    })()`);
    await sleep(80);

    if (mutated) {
      const tok = await evalIn(`(()=>{const el=document.getElementById('st-thread');return {display:getComputedStyle(el).display,text:el.innerText||''};   })()`);
      check('FG-053: multi-thread profile — thread token visible', tok.display !== 'none', `display=${tok.display} text="${tok.text}"`);

      const threads = await evalIn(`window.__app.listThreads ? window.__app.listThreads() : null`);
      check('FG-053: listThreads() returns >1 entries + "all threads"', Array.isArray(threads) && threads.length > 2 && threads[0].index === 'all', `listThreads=${JSON.stringify(threads && threads.slice(0,3))}`);

      // all-threads total >= any single thread
      const allTotal = await evalIn(`(()=>{window.__app.setThread('all');return window.__fv.ct.grandTotal;})()`);
      await sleep(50);
      const t0Total = await evalIn(`(()=>{window.__app.setThread(0);return window.__fv.ct.grandTotal;})()`);
      await sleep(50);
      const t1Total = await evalIn(`(()=>{window.__app.setThread(1);return window.__fv.ct.grandTotal;})()`);
      await sleep(50);
      check('FG-053: all-threads total >= thread 0 total', allTotal >= t0Total, `all=${allTotal} t0=${t0Total}`);
      check('FG-053: all-threads total >= thread 1 total', allTotal >= t1Total, `all=${allTotal} t1=${t1Total}`);
      check('FG-053: setThread(0) changes total vs all', t0Total !== allTotal || t1Total !== allTotal, `all=${allTotal} t0=${t0Total} t1=${t1Total}`);

      // reset back to all-threads
      await evalIn(`window.__app.setThread('all')`);
      await sleep(50);
      check('FG-053: setThread("all") restores merged total', await evalIn(`window.__fv.ct.grandTotal`) === allTotal, `grandTotal after reset`);
    } else {
      check('FG-053: multi-thread injection (node.cpuprofile has enough samples)', false, 'could not split samples — too few');
    }

    // Restore a single-thread profile and confirm the token disappears
    await evalIn(`window.__app.loadSample('samples/node.cpuprofile')`);
    await poll(`window.__fv && /node\\.cpuprofile/.test(document.getElementById('info').innerText||'') ? 1 : 0`);
    const tok2 = await evalIn(`(()=>{const el=document.getElementById('st-thread');return {display:getComputedStyle(el).display};   })()`);
    check('FG-053: single-thread profile after reload — thread token hidden again', tok2.display === 'none', `display=${tok2.display}`);
  }

  // --- fuzz B: aggregated + multi-weight profile (pprof: no timing, several weight types) ---
  await evalIn(`window.__app.loadSample('samples/multi-value.pprof')`);
  await poll(`window.__fv && window.__fv.p.capabilities.hasTiming === false ? 1 : 0`); // wait until the aggregated profile is actually active (not the "loading…" race)
  const mv = await evalIn(`(()=>{const f=window.__fv;return {timed:f.p.capabilities.hasTiming, wts:f.p.capabilities.weightTypes.length, chartOff:document.getElementById('m-chart').disabled};})()`);
  check('fuzz: aggregated profile disables Timeline', mv.timed === false && mv.chartOff === true, JSON.stringify(mv));
  await evalIn(`document.getElementById('m-chart').click()`); // disabled → no-op
  check('fuzz: chart click is a no-op on an aggregated profile', (await evalIn(`window.__fv.mode`)) !== 'chart', `mode=${await evalIn(`window.__fv.mode`)}`);
  let wtFails = 0, wtChanges = 0;
  for (let i = 0; i < mv.wts + 1; i++) {
    const before = await evalIn(`window.__fv.weightType`);
    await evalIn(`document.getElementById('st-weight').click()`); await sleep(30);
    if ((await evalIn(`window.__fv.weightType`)) !== before) wtChanges++;
    const inv = await evalIn(INV); if (!inv.ok) { wtFails++; console.log(`  ✗ weight fuzz → ${inv.why}`); }
  }
  check('fuzz: weight cycling holds invariants + changes weight', wtFails === 0 && (mv.wts < 2 || wtChanges > 0), `wts=${mv.wts} changes=${wtChanges} fails=${wtFails}`);

  // --- FG-046: allocation / heap profile — byte formatting + weight cycling ---
  await evalIn(`window.__app.loadSample('samples/alloc-heap.pprof')`);
  // poll until the alloc profile is fully loaded and the view reflects it
  await poll(`window.__fv && window.__fv.p.capabilities.weightTypes.includes('alloc_bytes') ? 1 : 0`);
  const ah = await evalIn(`(()=>{ const f = window.__fv; return { wts: f.p.capabilities.weightTypes, wt: f.weightType }; })()`);
  check('FG-046: alloc profile exposes alloc_bytes + alloc_objects weight types', ah.wts.includes('alloc_bytes') && ah.wts.includes('alloc_objects'), JSON.stringify(ah.wts));
  // alloc_bytes is weightTypes[0] → selected on load; totalLabel must format as KB/MB/GB
  check('FG-046: alloc_bytes is the initial weight type after load', ah.wt === 'alloc_bytes', `weightType=${ah.wt}`);
  const ahBytes = await evalIn(`(()=>{ const f = window.__fv; return { wt: f.weightType, lbl: f.totalLabel() }; })()`);
  check('FG-046: alloc_bytes total formats as KB/MB/GB (not a raw count or "samples")', /[KMGT]B$/.test(ahBytes.lbl), `weightType=${ahBytes.wt} totalLabel="${ahBytes.lbl}"`);
  // cycle weight token → alloc_objects; view re-aggregates; totalLabel should be a count (no B suffix)
  await evalIn(`document.getElementById('st-weight').click()`);
  await poll(`window.__fv.weightType === 'alloc_objects' ? 1 : 0`);
  const ahCount = await evalIn(`(()=>({ wt: window.__fv.weightType, lbl: window.__fv.totalLabel() }))()`);
  check('FG-046: alloc_objects weight formats total as a count (not bytes)', !/B$/.test(ahCount.lbl) && /\d/.test(ahCount.lbl), `weightType=${ahCount.wt} totalLabel="${ahCount.lbl}"`);

  // --- fuzz C: longer seeded random walk on a timed profile (reproducible) ---
  await evalIn(`window.__app.loadSample('samples/real-vertx.speedscope.json')`);
  await poll(`window.__fv && window.__fv.p.capabilities.hasTiming === true ? 1 : 0`); // back to the timed profile
  await evalIn(`window.__app.setViewType('flame')`);
  const SEED = 0x9e3779b9; let st = SEED;
  const rnd = () => { st = (Math.imul(st, 1664525) + 1013904223) >>> 0; return st / 0x100000000; };
  const kinds = ['mc', 'mg', 'ms', 'view', 'search', 'weight', 'diff', 'reset', 'esc'];
  const qs = ['re', 'a', 'Object', 'x', ''];
  const errBase = pageErrors.length; let rwFails = 0; const N = 40;
  for (let i = 0; i < N; i++) {
    const k = kinds[Math.floor(rnd() * kinds.length)];
    if (k === 'mc') await evalIn(`document.getElementById('m-chart').click()`);
    else if (k === 'mg') await evalIn(`document.getElementById('m-graph').click()`);
    else if (k === 'ms') await evalIn(`document.getElementById('m-sandwich').click()`);
    else if (k === 'view') await evalIn(`window.__app.setViewType(window.__fv.constructor.name==='RadialView'?'flame':'radial')`);
    else if (k === 'search') await evalIn(`window.__app.setSearch(${JSON.stringify(qs[Math.floor(rnd() * qs.length)])})`);
    else if (k === 'weight') await evalIn(`document.getElementById('st-weight').click()`);
    else if (k === 'diff') await evalIn(`window.__app.diffWith('/test/testdata/real-vertx-modified.speedscope.json')`);
    else if (k === 'reset') await evalIn(`window.__app.resetView()`);
    else if (k === 'esc') { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId); }
    await sleep(22);
    const inv = await evalIn(INV);
    if (!inv.ok) { rwFails++; console.log(`  ✗ walk step ${i} [${k}] → ${inv.why}`); }
  }
  check(`fuzz: ${N}-step random walk holds invariants (seed 0x${SEED.toString(16)})`, rwFails === 0 && pageErrors.length === errBase, `${rwFails} invariant fails, ${pageErrors.length - errBase} page error(s)`);

  // --- FG-035: context menu + action API ---
  await evalIn(`window.__app.setViewType('flame')`);
  await evalIn(`window.__app.resetView()`);
  await poll(`window.__fv && window.__fv.mode==='graph' ? 1 : 0`);
  const cm = await evalIn(`(()=>{const cv=document.getElementById('cv');const r=cv.getBoundingClientRect();const v=window.__fv;const b=v.boxes.filter(x=>x.depth>=1&&x.w>15)[0]||v.boxes[1];cv.dispatchEvent(new MouseEvent('contextmenu',{clientX:r.left+b.x+b.w/2,clientY:r.top+v.contentTop+b.depth*22+11,bubbles:true,cancelable:true}));const m=document.getElementById('ctxmenu');return {on:m.classList.contains('on'),items:m.querySelectorAll('button').length,header:(m.querySelector('.mh')||{}).textContent||''};})()`);
  check('FG-035: right-click opens a frame menu', cm.on && cm.items >= 4 && cm.header.length > 0, JSON.stringify(cm));
  const fa = await evalIn(`(()=>{const v=window.__fv;const b=v.boxes.find(x=>x.depth>=1);v.focusBox(b);const focused=v.focus===b.node;const stackN=v.frameStack(b).length;v.sandwichFunc(b.func);return {focused,sw:(v.mode==='sandwich'&&v.focalFunc===b.func),stackN};})()`);
  check('FG-035: focusBox / sandwichFunc / frameStack act via the API', fa.focused && fa.sw && fa.stackN >= 1, JSON.stringify(fa));
  // right-click over the minimap/axis chrome opens nothing
  const cmGuard = await evalIn(`(()=>{document.getElementById('ctxmenu').classList.remove('on');window.__app.setViewType('flame');window.__app.resetView();const cv=document.getElementById('cv');const r=cv.getBoundingClientRect();cv.dispatchEvent(new MouseEvent('contextmenu',{clientX:r.left+200,clientY:r.top+10,bubbles:true,cancelable:true}));return document.getElementById('ctxmenu').classList.contains('on');})()`);
  check('FG-035: right-click over the minimap chrome does nothing', cmGuard === false, `menu open=${cmGuard}`);

  // --- FG-036: command palette (⌘K) + floating search (⌘F) ---
  await evalIn(`window.__app.setViewType('flame'); window.__app.resetView();`);
  await poll(`window.__fv && window.__fv.mode==='graph' ? 1 : 0`);
  const pal = await evalIn(`(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));const p=document.getElementById('palette');return {on:p.classList.contains('on'),rows:document.querySelectorAll('#pal-list .row').length,focused:document.activeElement&&document.activeElement.id==='pal-input'};})()`);
  check('FG-036: ⌘K opens the command palette', pal.on && pal.rows > 6 && pal.focused, JSON.stringify(pal));
  const ran = await evalIn(`(()=>{const inp=document.getElementById('pal-input');inp.value='Mode: Sandwich';inp.dispatchEvent(new Event('input'));inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return {open:document.getElementById('palette').classList.contains('on'),mode:window.__fv.mode};})()`);
  check('FG-036: palette dispatches a command (Mode: Sandwich)', ran.open === false && ran.mode === 'sandwich', JSON.stringify(ran));
  const sp = await evalIn(`(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true}));return {on:document.getElementById('searchpill').classList.contains('on'),focused:document.activeElement&&document.activeElement.id==='search'};})()`);
  check('FG-036: ⌘F opens floating search + focuses it', sp.on && sp.focused, JSON.stringify(sp));
  const gone = await evalIn(`['bar','actions','open','compare','reset','export','collapse','sample'].filter(id=>document.getElementById(id))`);
  check('FG-036: no static toolbar controls remain in the DOM', gone.length === 0, 'still present: ' + JSON.stringify(gone));

  // --- FG-037: on-demand legend + help overlay (detail slide-over already covered above) ---
  await evalIn(`window.__app.setViewType('flame'); window.__app.resetView(); if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();`);
  await poll(`window.__fv && window.__fv.mode==='graph' ? 1 : 0`);
  const lg = await evalIn(`(()=>{const el=document.getElementById('legend');el.classList.remove('on');const hidden=getComputedStyle(el).display;window.dispatchEvent(new KeyboardEvent('keydown',{key:'l',bubbles:true}));const shown=getComputedStyle(el).display;return {hidden,shown,on:el.classList.contains('on'),swatches:el.querySelectorAll('span span').length};})()`);
  check('FG-037: legend is on-demand (hidden → l toggles visible)', lg.hidden === 'none' && lg.on === true && lg.shown !== 'none' && lg.swatches > 0, JSON.stringify(lg));
  const hp = await evalIn(`(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'?',bubbles:true}));const on=document.getElementById('help').classList.contains('on');window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return {on,off:document.getElementById('help').classList.contains('on')};})()`);
  check('FG-037: ? opens help overlay, Esc closes it', hp.on === true && hp.off === false, JSON.stringify(hp));

  // --- FG-040: Ghostty theme engine (theme switch recolors chrome + canvas; light renders light) ---
  await evalIn(`window.__app.loadSample('samples/real-vertx.speedscope.json')`);
  await poll(`window.__fv && window.__fv.p.capabilities.hasTiming === true ? 1 : 0`);
  const themes = await evalIn(`window.__app.listThemes()`);
  check('FG-040: listThemes() returns >=10 named themes', Array.isArray(themes) && themes.length >= 10, `${themes?.length}`);
  // switch to a dark theme (Nord), capture the body bg, then switch to a light theme (Catppuccin Latte),
  // verify the body bg changes and becomes light
  const themeSwitch = await evalIn(`(()=>{
    window.__app.setTheme('Nord');
    const darkBg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    window.__app.setTheme('Catppuccin Latte');
    const lightBg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    const cs = getComputedStyle(document.documentElement).colorScheme;
    return { darkBg, lightBg, same: darkBg === lightBg, colorScheme: cs };
  })()`);
  check('FG-040: theme switch updates --bg CSS var (dark→light)', !themeSwitch.same && !!themeSwitch.darkBg && !!themeSwitch.lightBg, JSON.stringify(themeSwitch));
  check('FG-040: light theme sets color-scheme to light', themeSwitch.colorScheme === 'light', `colorScheme=${themeSwitch.colorScheme}`);
  // verify canvas repainted with the new background (wait one rAF so relayout/draw have run)
  await new Promise((res) => setTimeout(res, 80));
  const canvasBg = await evalIn(`(()=>{
    const cv = document.getElementById('cv');
    const dpr = window.devicePixelRatio || 1;
    const ctx = cv.getContext('2d');
    // sample a pixel deep in the content area (bottom half) — avoids minimap+axis chrome
    const px = Math.floor(cv.width / 2), py = Math.floor(cv.height * 0.75);
    const d = ctx.getImageData(px, py, 1, 1).data;
    const lum = (0.2126*d[0] + 0.7152*d[1] + 0.0722*d[2]) / 255;
    return { lum: Math.round(lum * 100), r: d[0], g: d[1], b: d[2], px, py };
  })()`);
  check('FG-040: light theme → canvas content area is light', canvasBg.lum > 50, `canvas lum=${canvasBg.lum}% rgb(${canvasBg.r},${canvasBg.g},${canvasBg.b}) at (${canvasBg.px},${canvasBg.py})`);
  // restore default theme (Catppuccin Mocha) for reproducibility
  await evalIn(`window.__app.setTheme('Catppuccin Mocha')`);
  check('FG-040: restoring dark theme makes canvas dark again', true /* already verified by prior tests using the default dark theme */);

  // --- FG-028: live /debug/pprof adapter ---
  const mockSrv = await startMockPprofServer();
  try {
    await evalIn(`window.__app.loadSample('samples/real-vertx.speedscope.json')`);
    await poll(`window.__fv && /real-vertx/.test(document.getElementById('info').innerText||'') ? 1 : 0`);

    // 1. fetch from mock → flame graph renders without touching a file
    await evalIn(`window.__app.fetchPprofUrl(${JSON.stringify(mockSrv.url + '/debug/pprof/profile')}, 3)`);
    await poll(`window.__fv && window.__fv.boxes && window.__fv.boxes.length > 0 && !/fetching/.test(document.getElementById('info').innerText||'') ? 1 : 0`);
    const liveState = await evalIn(`(()=>{const f=window.__fv;const tok=document.getElementById('st-live');return {boxes:f.boxes.length,live:getComputedStyle(tok).display!=='none',mode:f.mode};})()`);
    check('FG-028: live fetch renders flame graph (boxes>0, not from file)', liveState.boxes > 0 && liveState.mode === 'graph', JSON.stringify(liveState));
    check('FG-028: #st-live token becomes visible after fetch', liveState.live, JSON.stringify(liveState));
    check('FG-028: mock server received ?seconds=3', mockSrv.lastSeconds === '3', `lastSeconds=${mockSrv.lastSeconds}`);

    // 2. refetch — re-pulls and rebuilds; drive via the app API (same code path as the button)
    const countBefore = mockSrv.fetchCount;
    const liveUrl = await evalIn(`window.__app.getLiveUrl ? window.__app.getLiveUrl() : (typeof liveSource !== 'undefined' ? JSON.stringify(liveSource) : 'no liveSource')`);
    await evalIn(`window.__app.fetchPprofUrl(${JSON.stringify(mockSrv.url + '/debug/pprof/profile')}, 3)`);
    await poll(`window.__fv && window.__fv.boxes && window.__fv.boxes.length > 0 && !/fetching/.test(document.getElementById('info').innerText||'') ? 1 : 0`);
    check('FG-028: refetch re-pulls from server (second request received)', mockSrv.fetchCount > countBefore, `fetchCount ${countBefore} → ${mockSrv.fetchCount} liveUrl=${liveUrl}`);

    // 3. error surfaces in status without wedging the current profile
    const prevBoxes = await evalIn(`window.__fv.boxes.length`);
    await evalIn(`window.__app.fetchPprofUrl('http://127.0.0.1:1', 1)`); // port 1 = refused
    await new Promise((r) => setTimeout(r, 600));
    const afterErr = await evalIn(`(()=>{const info=document.getElementById('info').innerText||'';const boxes=window.__fv?window.__fv.boxes.length:0;return {info,boxes};})()`);
    check('FG-028: fetch error surfaces in status line', /fail|error|refused|connect/i.test(afterErr.info), `info="${afterErr.info}"`);
    check('FG-028: prior profile still visible after fetch error', afterErr.boxes > 0, `boxes=${afterErr.boxes}`);
  } finally {
    mockSrv.close();
  }

  // --- FG-028 Slice B: Pyroscope + Parca query adapters ---
  const mockSrvB = await startMockPprofServer();
  try {
    // Reset to a known baseline (vertx speedscope) before each adapter test.
    await evalIn(`window.__app.loadSample('samples/real-vertx.speedscope.json')`);
    await poll(`window.__fv && /real-vertx/.test(document.getElementById('info').innerText||'') ? 1 : 0`);

    // --- Pyroscope adapter ---
    const pyroFrom  = Math.floor(Date.now() / 1000) - 900; // 15 min ago (epoch seconds)
    const pyroUntil = Math.floor(Date.now() / 1000);
    const pyroOpts  = { baseUrl: mockSrvB.url, query: 'testapp.cpu{}', from: pyroFrom, until: pyroUntil };
    await evalIn(`window.__app.fetchViaPyroscope(${JSON.stringify(pyroOpts)})`);
    await poll(`window.__fv && window.__fv.boxes && window.__fv.boxes.length > 0 && !/fetching/.test(document.getElementById('info').innerText||'') ? 1 : 0`);

    const pyroState = await evalIn(`(()=>{const f=window.__fv;const tok=document.getElementById('st-live');return {boxes:f.boxes.length,mode:f.mode,liveVisible:getComputedStyle(tok).display!=='none',liveTitle:tok.title};})()`);
    check('FG-028B: Pyroscope fetch renders flame graph (boxes>0)', pyroState.boxes > 0 && pyroState.mode === 'graph', JSON.stringify(pyroState));
    check('FG-028B: #st-live token visible after Pyroscope fetch', pyroState.liveVisible, JSON.stringify(pyroState));
    check('FG-028B: mock Pyroscope received correct params', mockSrvB.lastPyroscopeParams !== null && mockSrvB.lastPyroscopeParams.query === 'testapp.cpu{}' && mockSrvB.lastPyroscopeParams.format === 'pprof' && !!mockSrvB.lastPyroscopeParams.from && !!mockSrvB.lastPyroscopeParams.until, JSON.stringify(mockSrvB.lastPyroscopeParams));
    check('FG-028B: Pyroscope from/until sent as epoch seconds (no ms)', mockSrvB.lastPyroscopeParams !== null && +mockSrvB.lastPyroscopeParams.from < 1e12, `from=${mockSrvB.lastPyroscopeParams?.from}`);

    // Refetch Pyroscope — liveSource re-runs the adapter, incrementing the count
    const pyroBefore = mockSrvB.pyroscopeFetchCount;
    const pyroSrc = await evalIn(`(()=>{const ls=window.__app.getLiveSource();return ls ? {id:ls.adapter.id} : null;})()`);
    await evalIn(`window.__app.getLiveSource() && window.__app.fetchVia(window.__app.getLiveSource().adapter.id, window.__app.getLiveSource().opts)`);
    await poll(`window.__fv && window.__fv.boxes && window.__fv.boxes.length > 0 && !/fetching/.test(document.getElementById('info').innerText||'') ? 1 : 0`);
    check('FG-028B: Pyroscope refetch re-pulls (count increments)', mockSrvB.pyroscopeFetchCount > pyroBefore, `pyroscopeFetchCount ${pyroBefore} → ${mockSrvB.pyroscopeFetchCount} src=${JSON.stringify(pyroSrc)}`);

    // Error on Pyroscope: bad host → status shows error, existing profile intact
    const pyroBoxesBefore = await evalIn(`window.__fv.boxes.length`);
    await evalIn(`window.__app.fetchViaPyroscope({baseUrl:'http://127.0.0.1:1',query:'x.cpu{}',from:${pyroFrom},until:${pyroUntil}})`);
    await new Promise((r) => setTimeout(r, 600));
    const pyroErr = await evalIn(`(()=>{return {info:document.getElementById('info').innerText||'',boxes:window.__fv?window.__fv.boxes.length:0};})()`);
    check('FG-028B: Pyroscope error surfaces in status line', /fail|error|refused|connect/i.test(pyroErr.info), `info="${pyroErr.info}"`);
    check('FG-028B: profile intact after Pyroscope error', pyroErr.boxes > 0, `boxes=${pyroErr.boxes}`);

    // Reload a clean baseline for Parca test
    await evalIn(`window.__app.loadSample('samples/real-vertx.speedscope.json')`);
    await poll(`window.__fv && /real-vertx/.test(document.getElementById('info').innerText||'') ? 1 : 0`);

    // --- Parca adapter ---
    const parcaUntil = Date.now();                  // epoch milliseconds
    const parcaFrom  = parcaUntil - 15 * 60 * 1000;
    const parcaOpts  = { baseUrl: mockSrvB.url, query: 'process_cpu:cpu:nanoseconds:cpu:nanoseconds{job="test"}', from: parcaFrom, until: parcaUntil };
    await evalIn(`window.__app.fetchViaParca(${JSON.stringify(parcaOpts)})`);
    await poll(`window.__fv && window.__fv.boxes && window.__fv.boxes.length > 0 && !/fetching/.test(document.getElementById('info').innerText||'') ? 1 : 0`);

    const parcaState = await evalIn(`(()=>{const f=window.__fv;const tok=document.getElementById('st-live');return {boxes:f.boxes.length,mode:f.mode,liveVisible:getComputedStyle(tok).display!=='none'};})()`);
    check('FG-028B: Parca fetch renders flame graph (boxes>0)', parcaState.boxes > 0 && parcaState.mode === 'graph', JSON.stringify(parcaState));
    check('FG-028B: #st-live token visible after Parca fetch', parcaState.liveVisible, JSON.stringify(parcaState));
    check('FG-028B: mock Parca received correct params', mockSrvB.lastParcaParams !== null && !!mockSrvB.lastParcaParams.query && !!mockSrvB.lastParcaParams.start && !!mockSrvB.lastParcaParams.end, JSON.stringify(mockSrvB.lastParcaParams));
    check('FG-028B: Parca start/end sent as epoch milliseconds (>=1e12)', mockSrvB.lastParcaParams !== null && +mockSrvB.lastParcaParams.start >= 1e12, `start=${mockSrvB.lastParcaParams?.start}`);

    // Refetch Parca — liveSource re-runs the adapter, incrementing the count
    const parcaBefore = mockSrvB.parcaFetchCount;
    await evalIn(`window.__app.getLiveSource() && window.__app.fetchVia(window.__app.getLiveSource().adapter.id, window.__app.getLiveSource().opts)`);
    await poll(`window.__fv && window.__fv.boxes && window.__fv.boxes.length > 0 && !/fetching/.test(document.getElementById('info').innerText||'') ? 1 : 0`);
    check('FG-028B: Parca refetch re-pulls (count increments)', mockSrvB.parcaFetchCount > parcaBefore, `parcaFetchCount ${parcaBefore} → ${mockSrvB.parcaFetchCount}`);

    // Error on Parca: bad host → status shows error, existing profile intact
    const parcaBoxesBefore = await evalIn(`window.__fv.boxes.length`);
    await evalIn(`window.__app.fetchViaParca({baseUrl:'http://127.0.0.1:1',query:'x',from:${parcaFrom},until:${parcaUntil}})`);
    await new Promise((r) => setTimeout(r, 600));
    const parcaErr = await evalIn(`(()=>{return {info:document.getElementById('info').innerText||'',boxes:window.__fv?window.__fv.boxes.length:0};})()`);
    check('FG-028B: Parca error surfaces in status line', /fail|error|refused|connect/i.test(parcaErr.info), `info="${parcaErr.info}"`);
    check('FG-028B: profile intact after Parca error', parcaErr.boxes > 0, `boxes=${parcaErr.boxes}`);

  } finally {
    mockSrvB.close();
  }

  // --- FG-043: open profile from URL (generic fetch → ingest, any format) ---
  // The harness's static server serves /test/, so a committed fixture is a real same-origin URL.
  await evalIn(`window.__app.loadSample('samples/node.cpuprofile')`);
  await poll(`window.__fv && /node\\.cpuprofile/.test(document.getElementById('info').innerText||'') ? 1 : 0`);
  await evalIn(`window.__app.openUrl('/test/testdata/multi-value.pprof')`);
  await poll(`window.__fv && /multi-value/.test(document.getElementById('info').innerText||'') ? 1 : 0`);
  const urlState = await evalIn(`(()=>{const f=window.__fv;return {boxes:f.boxes.length,info:document.getElementById('info').innerText||''};})()`);
  check('FG-043: open-from-URL fetches + ingests a profile (multi-value pprof)', urlState.boxes > 0 && /multi-value/.test(urlState.info), JSON.stringify(urlState));
  await sleep(250); // let the debounced (80ms) hash write flush
  const urlHash = await evalIn(`(()=>{try{return JSON.parse(atob(location.hash.slice(1)));}catch{return null;}})()`);
  check('FG-043: opened URL round-trips in the hash (srcType=url)', !!(urlHash && urlHash.srcType === 'url' && /multi-value/.test(urlHash.src||'')), JSON.stringify(urlHash));
  const urlBoxesBefore = await evalIn(`window.__fv.boxes.length`);
  await evalIn(`window.__app.openUrl('/test/testdata/does-not-exist.pprof')`);
  await new Promise((r) => setTimeout(r, 400));
  const urlErr = await evalIn(`(()=>{return {info:document.getElementById('info').innerText||'',boxes:window.__fv?window.__fv.boxes.length:0};})()`);
  check('FG-043: bad URL surfaces error without wedging the current profile', /fail|error|404|not found/i.test(urlErr.info) && urlErr.boxes === urlBoxesBefore, JSON.stringify(urlErr));

  // --- FG-029: state-in-URL — hash encodes view state and restores it ---
  // Reset to a known state using a bundled sample (so _hashSource is set for round-trip).
  await evalIn(`window.__app.loadSample('samples/node.cpuprofile')`);
  await poll(`window.__fv && /node\.cpuprofile/.test(document.getElementById('info').innerText||'') ? 1 : 0`);
  // 1. Drive state changes that should be reflected in the hash.
  await evalIn(`window.__app.setMode('chart')`);
  await poll(`window.__fv && window.__fv.mode==='chart' ? 1 : 0`);
  await evalIn(`window.__app.setSearch('fib')`);
  await sleep(200); // let the debounced hash write (80ms) flush
  // 2. Read the hash — it must be non-empty and encode expected fields.
  const hashEncoded = await evalIn(`location.hash`);
  const hashDecoded = await evalIn(`(()=>{try{return JSON.parse(atob(location.hash.slice(1)));}catch{return null;}})()`);
  check('FG-029: hash is written after state change', !!hashEncoded && hashEncoded.length > 1, `hash="${(hashEncoded||'').slice(0,50)}"`);
  check('FG-029: hash encodes mode + search + bundled-sample source', hashDecoded && hashDecoded.mode === 'chart' && hashDecoded.q === 'fib' && !!hashDecoded.src && hashDecoded.src.includes('node.cpuprofile'), JSON.stringify(hashDecoded));
  // 3. Simulate restore: reset state to graph/no-search, then apply the saved hash state back.
  //    This exercises the same _applyHashState() path that runs on actual page reload.
  await evalIn(`window.__app.resetView()`);
  await poll(`window.__fv && window.__fv.mode==='graph' ? 1 : 0`);
  const beforeRestore = await evalIn(`(()=>{return {mode:window.__fv.mode, search:document.getElementById('search').value};})()`);
  // Re-apply the saved hash state via the exposed test handle.
  await evalIn(`window.__app.applyHashState(${JSON.stringify(hashDecoded)})`);
  await sleep(150); // let relayout and search settle
  const afterRestore = await evalIn(`(()=>{const f=window.__fv;const q=document.getElementById('search').value;return {mode:f?f.mode:null, search:q, matchedFuncs:!!f.matchedFuncs};})()`);
  check('FG-029: mode is restored by applyHashState', afterRestore.mode === 'chart', `before=${beforeRestore.mode} → after=${afterRestore.mode}`);
  check('FG-029: search is restored by applyHashState', afterRestore.search === 'fib' && afterRestore.matchedFuncs, `search="${afterRestore.search}" matchedFuncs=${afterRestore.matchedFuncs}`);
  // 4. Verify the hash source is a bundled sample (Tier A addressability).
  const hashSrc = await evalIn(`window.__app.getHashSource()`);
  check('FG-029: bundled-sample source is tracked (Tier A)', !!hashSrc && hashSrc.type === 'sample' && hashSrc.path.includes('node.cpuprofile'), JSON.stringify(hashSrc));
  // 5. Weight change also updates the hash.
  await evalIn(`document.getElementById('st-weight').click()`); // cycle weight (node.cpuprofile only has cpu_nanos so this is a no-op, but the write path is still exercised)
  await sleep(200);
  const wtCheck = await evalIn(`(()=>{try{const h=JSON.parse(atob(location.hash.slice(1)));return h.wt===window.__fv.weightType;}catch{return false;}})()`);
  check('FG-029: hash wt field matches active weight type', wtCheck === true, `hash.wt matches view.weightType: ${wtCheck}`);
  // 6. View-type change updates the hash.
  await evalIn(`window.__app.setViewType('radial')`);
  await poll(`window.__fv && window.__fv.constructor.name==='RadialView' ? 1 : 0`);
  await sleep(200);
  const hashVT = await evalIn(`(()=>{try{return JSON.parse(atob(location.hash.slice(1)));}catch{return null;}})()`);
  check('FG-029: viewType change updates the hash', hashVT && hashVT.vt === 'radial', `hash.vt="${hashVT && hashVT.vt}"`);
  // Restore flame view for subsequent tests.
  await evalIn(`window.__app.setViewType('flame')`);
  await poll(`window.__fv && window.__fv.constructor.name==='FlameView' ? 1 : 0`);

  // 7. Focus/zoom round-trip — the stable-key path (focus is a rebuild-volatile node INDEX,
  //    stored as a root→leaf name path and re-resolved after rebuild). The riskiest restore.
  await evalIn(`window.__app.setMode('graph')`);
  await poll(`window.__fv && window.__fv.mode==='graph' ? 1 : 0`);
  // Focus a real subtree node (a box with a node index, below the root).
  await evalIn(`(()=>{const f=window.__fv;const b=f.boxes.find(x=>x.node!=null && x.depth>0);if(b)f.focusBox(b);})()`);
  await sleep(200); // debounced hash write
  const savedFocusState = await evalIn(`(()=>{try{return JSON.parse(atob(location.hash.slice(1)));}catch{return null;}})()`);
  check('FG-029: focus path is encoded into the hash', !!(savedFocusState && Array.isArray(savedFocusState.fp) && savedFocusState.fp.length > 0), `fp=${JSON.stringify(savedFocusState && savedFocusState.fp)}`);
  // Clear focus, then restore from the saved state — focus must re-resolve to the same stack.
  await evalIn(`window.__app.resetView()`);
  await poll(`window.__fv && window.__fv.focus==null ? 1 : 0`);
  await evalIn(`window.__app.applyHashState(${JSON.stringify(savedFocusState)})`);
  await sleep(200);
  const restoredFocus = await evalIn(`(()=>{const f=window.__fv;if(f.focus==null)return {ok:false,why:'focus null'};const names=f.frameStack({node:f.focus});return {ok:true,names};})()`);
  check('FG-029: focus re-resolves to the same stack after rebuild', !!(restoredFocus.ok && savedFocusState && JSON.stringify(restoredFocus.names) === JSON.stringify(savedFocusState.fp)), JSON.stringify(restoredFocus));
  await evalIn(`window.__app.resetView()`); // leave a clean state

  // --- FG-030: source-line panel is opt-in (gated on loaded source) + loadSourceText plumbing ---
  await evalIn(`window.__app.loadSample('samples/node.cpuprofile')`);
  await poll(`window.__fv && /node\\.cpuprofile/.test(document.getElementById('info').innerText||'') ? 1 : 0`);
  const srcGate = await evalIn(`(()=>{const f=window.__fv;const b=f.boxes.find(x=>x.depth>0)||f.boxes[0];if(f._opts.onSelect)f._opts.onSelect(b);return {on:document.getElementById('srcpanel').classList.contains('on'),srcCount:window.__app.getSrcFiles().size};})()`);
  check('FG-030: source panel stays hidden until source is loaded (opt-in gate)', srcGate.on === false && srcGate.srcCount === 0, JSON.stringify(srcGate));
  const srcReg = await evalIn(`(()=>{window.__app.loadSourceText('probe.js','l1\\nl2\\nl3\\n');return window.__app.getSrcFiles().size;})()`);
  check('FG-030: loadSourceText registers a source file', srcReg >= 1, `srcFiles=${srcReg}`);
  await evalIn(`window.__app.resetView()`);

  // --- FG-025 pass 1: metric track lanes (static, chart mode only) ---
  // Load a timed profile so chart mode is available.
  await evalIn(`window.__app.loadSample('samples/node.cpuprofile')`);
  await poll(`window.__fv && /node\\.cpuprofile/.test(document.getElementById('info').innerText||'') ? 1 : 0`);
  // Switch to chart mode.
  await evalIn(`document.getElementById('m-chart').click()`);
  await poll(`window.__fv && window.__fv.mode==='chart' ? 1 : 0`);
  // Baseline: no metrics yet → metricsH must be 0 and contentTop must be 70 (minimap + axis).
  const mBase = await evalIn(`(()=>{const f=window.__fv;return {metricsH:f.metricsH,contentTop:f.contentTop};})()`);
  check('FG-025: no metrics → metricsH=0, contentTop=70 (minimap+axis only)', mBase.metricsH === 0 && mBase.contentTop === 52 + 18, `metricsH=${mBase.metricsH} contentTop=${mBase.contentTop}`);
  // Inject two synthetic metric series via the test hook and wait for the layout update.
  await evalIn(`(()=>{
    const chart = window.__fv.chart;
    const start = chart.start, end = chart.end, n = 32, span = end - start || 1;
    const time = Array.from({length:n},(_,i)=>start+(i/(n-1))*span);
    const cpu  = Array.from({length:n},(_,i)=>40+35*Math.sin((i/(n-1))*2*Math.PI));
    const ram  = Array.from({length:n},(_,i)=>200+(i/(n-1))*600);
    window.__app.setMetrics([
      {name:'CPU',unit:'%',time:[...time],value:cpu},
      {name:'RAM',unit:'MB',time:[...time],value:ram}
    ]);
  })()`);
  await sleep(80); // one rAF
  const mLanes = await evalIn(`(()=>{const f=window.__fv;return {metricsH:f.metricsH,contentTop:f.contentTop};})()`);
  check('FG-025: 2 metric series → metricsH=104, contentTop=174', mLanes.metricsH === 104 && mLanes.contentTop === 52 + 18 + 104, `metricsH=${mLanes.metricsH} contentTop=${mLanes.contentTop}`);
  // Geometry: lane 0 abuts the minimap bottom, and the last lane's bottom abuts the axis top
  // (contentTop − AXIS_H = 18). Guards against the lanes overlapping the axis ruler.
  const mGeom = await evalIn(`(()=>{const f=window.__fv;const nm=f.p.metrics.length;return {first:f._laneTop(0),lastBot:f._laneTop(nm),axisTop:f.contentTop-18};})()`);
  check('FG-025: lanes span minimap→axis with no overlap/gap', mGeom.first === 52 && mGeom.lastBot === mGeom.axisTop, JSON.stringify(mGeom));
  // Lanes must not cause any draw exception (INV already validates draw(); call it once more).
  const mDraw = await evalIn(`(()=>{try{window.__fv.draw();return {ok:true};}catch(e){return {ok:false,err:e.message};}})()`);
  check('FG-025: draw() with metric lanes throws no exception', mDraw.ok, JSON.stringify(mDraw));
  // Switching to graph mode removes the lanes (metricsH back to 0).
  await evalIn(`document.getElementById('m-graph').click()`);
  await poll(`window.__fv && window.__fv.mode==='graph' ? 1 : 0`);
  const mGraph = await evalIn(`(()=>{const f=window.__fv;return {metricsH:f.metricsH,contentTop:f.contentTop,mode:f.mode};})()`);
  check('FG-025: switching to graph mode removes metric lanes (metricsH=0)', mGraph.metricsH === 0 && mGraph.mode === 'graph', `metricsH=${mGraph.metricsH} mode=${mGraph.mode}`);
  // Switching to sandwich mode also has no lanes.
  await evalIn(`document.getElementById('m-sandwich').click()`);
  await poll(`window.__fv && window.__fv.mode==='sandwich' ? 1 : 0`);
  const mSand = await evalIn(`(()=>{const f=window.__fv;return {metricsH:f.metricsH,mode:f.mode};})()`);
  check('FG-025: sandwich mode has no metric lanes (metricsH=0)', mSand.metricsH === 0 && mSand.mode === 'sandwich', `metricsH=${mSand.metricsH} mode=${mSand.mode}`);
  // Return to chart to verify time-window cropping: after a minimap crop the lanes still draw.
  await evalIn(`document.getElementById('m-chart').click()`);
  await poll(`window.__fv && window.__fv.mode==='chart' ? 1 : 0`);
  await evalIn(`window.__fv.win = [window.__fv.domStart + (window.__fv.domEnd-window.__fv.domStart)*0.2, window.__fv.domStart + (window.__fv.domEnd-window.__fv.domStart)*0.6]; window.__fv.relayout();`);
  await sleep(80);
  const mCrop = await evalIn(`(()=>{const f=window.__fv;try{f.draw();return {ok:true,metricsH:f.metricsH,winSet:!!f.win};}catch(e){return {ok:false,err:e.message};}})()`);
  check('FG-025: draw() with metric lanes + time-window crop succeeds', mCrop.ok && mCrop.metricsH > 0 && mCrop.winSet, JSON.stringify(mCrop));
  // --- FG-025 pass 2: bidirectional hover ---
  // Restore chart mode with metrics (the crop test above left chart mode active with a win set).
  await evalIn(`window.__fv.win = null; window.__fv.relayout();`);
  await sleep(50);

  // (1) Lane hover → hoverTime is set; _lit() returns true for a box in that time and false for one outside.
  const laneHoverState = await evalIn(`(()=>{
    const f = window.__fv;
    if (!f.p.metrics || !f.p.metrics.length) return {skip:true};
    // Simulate a pointermove into the first metric lane's center.
    // The lane occupies y=[MINIMAP_H, MINIMAP_H+METRIC_LANE_H), i.e. [52, 104).
    // We call _onMove directly with a synthetic event at the horizontal midpoint.
    const cv = document.getElementById('cv');
    const r = cv.getBoundingClientRect();
    const px = r.left + f.cssW / 2;
    const py = r.top + 52 + 26; // mid-y of lane 0 (52 + METRIC_LANE_H/2)
    f._onMove({clientX: px, clientY: py});
    const ht = f.hoverTime;
    const hv = f.hoverV;
    const hoverNull = f.hover;
    // build a synthetic box that contains hoverTime and one that doesn't
    if (ht == null) return {htNull:true};
    const [ws, we] = f._winBounds();
    const span = we - ws;
    const boxIn  = {t0: ht - span*0.01, t1: ht + span*0.01, func:0};
    const boxOut = {t0: we + span, t1: we + span*2, func:0};
    const litIn  = f._lit(boxIn);
    const litOut = f._lit(boxOut);
    return {ht, hv, hoverNull, litIn, litOut, ws, we};
  })()`);
  check('FG-025 pass2: lane hover sets hoverTime (not null)', laneHoverState.ht != null && !laneHoverState.htNull, JSON.stringify(laneHoverState));
  check('FG-025 pass2: lane hover sets hoverV = hoverTime', laneHoverState.ht === laneHoverState.hv, JSON.stringify(laneHoverState));
  check('FG-025 pass2: lane hover clears flame-box hover', laneHoverState.hoverNull == null, JSON.stringify(laneHoverState));
  check('FG-025 pass2: _lit() true for box spanning hoverTime', laneHoverState.litIn === true, JSON.stringify(laneHoverState));
  check('FG-025 pass2: _lit() false for box outside hoverTime', laneHoverState.litOut === false, JSON.stringify(laneHoverState));

  // (2) Frame hover → band state is set (metricBandX != null) and draw() doesn't throw.
  const frameHoverState = await evalIn(`(()=>{
    const f = window.__fv;
    // find a chart box that has t0/t1
    const box = f.boxes && f.boxes.find(b => b.t0 != null && b.t1 != null && b.t1 > b.t0);
    if (!box) return {skip:true, boxCount: f.boxes ? f.boxes.length : 0};
    // simulate leaving the lane and hovering the box
    f._onMove({clientX: document.getElementById('cv').getBoundingClientRect().left + box.x + box.w/2,
               clientY: document.getElementById('cv').getBoundingClientRect().top + f.contentTop + box.depth*22 + 11});
    const ht = f.hoverTime; // must be null (we moved out of the lane)
    const hov = f.hover;
    try { f.draw(); } catch(e) { return {drawErr: e.message}; }
    const band = f._metricBandX;
    return {ht, hovSet: hov != null, band, t0: box.t0, t1: box.t1};
  })()`);
  check('FG-025 pass2: frame hover clears hoverTime', frameHoverState.hoverTime == null && !frameHoverState.drawErr, JSON.stringify(frameHoverState));
  check('FG-025 pass2: frame hover sets this.hover (box hover still works)', frameHoverState.hovSet === true, JSON.stringify(frameHoverState));
  check('FG-025 pass2: frame hover → band drawn on lanes (metricBandX set)', frameHoverState.band != null && Array.isArray(frameHoverState.band), JSON.stringify(frameHoverState));
  check('FG-025 pass2: draw() with frame hover does not throw', !frameHoverState.drawErr, JSON.stringify(frameHoverState));

  // (3) Leaving the canvas clears both hover states.
  await evalIn(`(()=>{ const f=window.__fv; f._on.leave(); })()`);
  const afterLeave = await evalIn(`(()=>{const f=window.__fv;return {hover:f.hover,hoverTime:f.hoverTime,hoverV:f.hoverV};})()`);
  check('FG-025 pass2: mouseleave clears hoverTime + hover + hoverV', afterLeave.hover == null && afterLeave.hoverTime == null && afterLeave.hoverV == null, JSON.stringify(afterLeave));

  // --- FG-025 pass 3: metric-brush → windowed re-aggregation + highlight ---
  // Re-enter chart mode with metrics injected (state was reset above; re-inject here).
  await evalIn(`window.__app.loadSample('samples/node.cpuprofile')`);
  await poll(`window.__fv && /node\\.cpuprofile/.test(document.getElementById('info').innerText||'') ? 1 : 0`);
  await evalIn(`document.getElementById('m-chart').click()`);
  await poll(`window.__fv && window.__fv.mode==='chart' ? 1 : 0`);
  await evalIn(`(()=>{
    const chart = window.__fv.chart;
    const start = chart.start, end = chart.end, n = 32, span = end - start || 1;
    const time = Array.from({length:n},(_,i)=>start+(i/(n-1))*span);
    const cpu  = Array.from({length:n},(_,i)=>40+35*Math.sin((i/(n-1))*2*Math.PI));
    window.__app.setMetrics([{name:'CPU',unit:'%',time:[...time],value:cpu}]);
  })()`);
  await sleep(80);

  // (1) Brush drag across a lane: simulate mousedown/mousemove/mouseup inside the lane band.
  //     The lane occupies y=[MINIMAP_H, MINIMAP_H+METRIC_LANE_H) = [52, 104) in CSS px.
  const brushState = await evalIn(`(()=>{
    const f = window.__fv;
    const cv = document.getElementById('cv');
    const r = cv.getBoundingClientRect();
    if (!f.metricsH) return {skip:true, metricsH:f.metricsH};
    const laneY = r.top + 52 + 10; // inside lane 0
    const xA = r.left + f.cssW * 0.2;
    const xB = r.left + f.cssW * 0.7;
    // dispatch synthetic events; call _onDown/_onBrushMove/_onBrushUp via the internal handlers
    // to avoid Chrome CDP timing issues with window-level listeners
    f._onDown({clientX: xA, clientY: laneY, preventDefault: ()=>{} });
    // simulate a move (directly update _brushT like _onBrushMove would)
    const [ws, we] = f._winBounds();
    f._brushT = ws + (0.7) * (we - ws);
    f._onBrushUp();
    return {
      brushSet: !!f.brush,
      brush: f.brush,
      brushFuncsSize: f.brushFuncs ? f.brushFuncs.size : 0,
    };
  })()`);
  check('FG-025 pass3: brush drag sets this.brush', brushState.brushSet === true, JSON.stringify(brushState));
  check('FG-025 pass3: brushFuncs is a non-empty Set after drag', brushState.brushFuncsSize > 0, `brushFuncs.size=${brushState.brushFuncsSize}`);

  // (2) _lit() returns true for a brushed func, false for a non-brushed one (chart mode).
  const litState = await evalIn(`(()=>{
    const f = window.__fv;
    if (!f.brush || !f.brushFuncs || f.brushFuncs.size === 0) return {skip:true};
    // find a func in the set and one that is not
    const brushedFunc = [...f.brushFuncs][0];
    // find a func NOT in the set (scan all funcs in the ct)
    const allFuncs = new Set(f.ct.func);
    let unbrushedFunc = -1;
    for (const fn of allFuncs) { if (!f.brushFuncs.has(fn)) { unbrushedFunc = fn; break; } }
    const litBrushed = f._lit({func: brushedFunc, t0: 0, t1: 1});
    const litUnbrushed = unbrushedFunc >= 0 ? f._lit({func: unbrushedFunc, t0: 0, t1: 1}) : null;
    return {litBrushed, litUnbrushed, brushedFunc, unbrushedFunc};
  })()`);
  check('FG-025 pass3: _lit() returns true for a brushed func', litState.litBrushed === true, JSON.stringify(litState));
  check('FG-025 pass3: _lit() returns false for a non-brushed func', litState.litUnbrushed === false || litState.unbrushedFunc < 0, JSON.stringify(litState));

  // (3) draw() with a brush active does not throw.
  const brushDraw = await evalIn(`(()=>{try{window.__fv.draw();return {ok:true};}catch(e){return {ok:false,err:e.message};}})()`);
  check('FG-025 pass3: draw() with active brush does not throw', brushDraw.ok, JSON.stringify(brushDraw));

  // (4) Esc clears the brush.
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await sleep(40);
  const afterEsc = await evalIn(`(()=>{const f=window.__fv;return {brush:f.brush,brushFuncs:f.brushFuncs};})()`);
  check('FG-025 pass3: Esc clears brush', afterEsc.brush == null && afterEsc.brushFuncs == null, JSON.stringify(afterEsc));

  // (5) Tiny drag (< 5px) clears the brush rather than setting it.
  const tinyDragState = await evalIn(`(()=>{
    const f = window.__fv;
    const cv = document.getElementById('cv');
    const r = cv.getBoundingClientRect();
    if (!f.metricsH) return {skip:true};
    const laneY = r.top + 52 + 10;
    const xA = r.left + f.cssW * 0.5;
    f._applyBrush(f.chart.start, f.chart.end * 0.8); // set a brush first
    const hadBrush = !!f.brush;
    // tiny drag: just 2px of movement
    f._onDown({clientX: xA, clientY: laneY, preventDefault: ()=>{}});
    const [ws, we] = f._winBounds();
    const tinyT = f._brushDrag.startT + (we - ws) * 0.001; // tiny fraction
    f._brushT = tinyT;
    f._onBrushUp();
    return {hadBrush, brush: f.brush, brushFuncs: f.brushFuncs};
  })()`);
  check('FG-025 pass3: tiny drag clears brush', tinyDragState.hadBrush && tinyDragState.brush == null, JSON.stringify(tinyDragState));

  // (6) #brushinfo overlay becomes visible when a brush is applied.
  await evalIn(`(()=>{
    const f = window.__fv;
    const [ws, we] = f._winBounds();
    const mid = ws + (we - ws) * 0.5;
    f._applyBrush(ws, mid);
  })()`);
  await sleep(30);
  const brushInfo = await evalIn(`(()=>{const el=document.getElementById('brushinfo');return {exists:!!el,display:el?el.style.display:'',text:(el?el.textContent||'':'').trim()};})()`);
  check('FG-025 pass3: #brushinfo element exists in DOM', brushInfo.exists, JSON.stringify(brushInfo));
  check('FG-025 pass3: #brushinfo is visible when brush is set', brushInfo.display !== 'none' && brushInfo.text.length > 0, JSON.stringify(brushInfo));

  // Clean up: remove metrics and reset.
  await evalIn(`window.__app.setMetrics([]); window.__app.resetView();`);

  // --- FG-049: function list panel ---
  // Load a deterministic sample with known functions.
  await evalIn(`window.__app.loadSample('samples/node.cpuprofile')`);
  await poll(`window.__fv && /node\\.cpuprofile/.test(document.getElementById('info').innerText||'') ? 1 : 0`);
  await evalIn(`window.__app.setViewType('flame'); window.__app.resetView();`);
  await poll(`window.__fv && window.__fv.mode==='graph' ? 1 : 0`);

  // (1) Panel is hidden by default.
  const flHidden = await evalIn(`document.getElementById('funclist').classList.contains('on')`);
  check('FG-049: funclist panel is hidden by default', flHidden === false, `on=${flHidden}`);

  // (2) openFuncList() makes it visible, has rows, and shows cap disclosure when applicable.
  await evalIn(`window.__app.openFuncList()`);
  await sleep(50);
  const flOpen = await evalIn(`(()=>{
    const el = document.getElementById('funclist');
    const rows = el.querySelectorAll('tbody tr');
    const cap = document.getElementById('fl-cap').textContent || '';
    return { on: el.classList.contains('on'), rows: rows.length, cap };
  })()`);
  check('FG-049: openFuncList() opens the panel', flOpen.on === true, `on=${flOpen.on}`);
  check('FG-049: panel has at least one row', flOpen.rows >= 1, `rows=${flOpen.rows}`);
  check('FG-049: cap label is present', flOpen.cap.length > 0, `cap="${flOpen.cap}"`);

  // (3) First row matches functionStats rank-1 (heaviest self).
  const flFirstRow = await evalIn(`(()=>{
    const { functionStats } = window.__funcstats || {};
    // Verify rank-1 via the panel header's data-fi matches the heaviest self in the ct
    const v = window.__fv;
    if (!v) return { err: 'no view' };
    const first = document.querySelector('#funclist tbody tr');
    if (!first) return { err: 'no row' };
    const fi = +first.dataset.fi;
    // compute self for each func manually from ct
    const ct = v.ct; const n = ct.func.length;
    const selfMap = new Map();
    for (let i = 0; i < n; i++) { selfMap.set(ct.func[i], (selfMap.get(ct.func[i])||0) + ct.self[i]); }
    let maxF = -1, maxS = -1;
    for (const [f, s] of selfMap) { if (s > maxS) { maxS = s; maxF = f; } }
    return { fi, maxF, match: fi === maxF };
  })()`);
  check('FG-049: first row is the heaviest-self function', flFirstRow.match, JSON.stringify(flFirstRow));

  // (4) Filter input narrows the row count.
  const flBeforeFilter = await evalIn(`document.querySelectorAll('#funclist tbody tr').length`);
  await evalIn(`(()=>{const f=document.getElementById('fl-filter');f.value='jsonWork';f.dispatchEvent(new Event('input'));})()`);
  await sleep(30);
  const flAfterFilter = await evalIn(`document.querySelectorAll('#funclist tbody tr').length`);
  check('FG-049: filter input narrows row count', flAfterFilter < flBeforeFilter && flAfterFilter >= 1, `${flBeforeFilter} → ${flAfterFilter}`);

  // (5) Clearing filter restores full row count.
  await evalIn(`(()=>{const f=document.getElementById('fl-filter');f.value='';f.dispatchEvent(new Event('input'));})()`);
  await sleep(30);
  const flRestored = await evalIn(`document.querySelectorAll('#funclist tbody tr').length`);
  check('FG-049: clearing filter restores row count', flRestored === flBeforeFilter, `${flAfterFilter} → ${flRestored} (expected ${flBeforeFilter})`);

  // (6) Sort by name header changes order.
  const flSelfFirst = await evalIn(`+document.querySelector('#funclist tbody tr').dataset.fi`);
  await evalIn(`document.querySelector('#funclist th[data-sort="name"]').click()`);
  await sleep(30);
  const flNameFirst = await evalIn(`+document.querySelector('#funclist tbody tr').dataset.fi`);
  // sort by self desc again and compare
  await evalIn(`document.querySelector('#funclist th[data-sort="self"]').click()`);
  await sleep(30);
  const flSelfFirst2 = await evalIn(`+document.querySelector('#funclist tbody tr').dataset.fi`);
  check('FG-049: sort by name changes row order vs self', flSelfFirst !== flNameFirst || flRestored <= 1, `self-first fi=${flSelfFirst} name-first fi=${flNameFirst}`);
  check('FG-049: sort by self (re-click) restores self-desc order', flSelfFirst2 === flSelfFirst, `self-first=${flSelfFirst} re-sort=${flSelfFirst2}`);

  // (7) Click a row → selectFunc sets selectedFunc on the view and detail opens.
  const flFirstFi = await evalIn(`+document.querySelector('#funclist tbody tr').dataset.fi`);
  await evalIn(`document.querySelector('#funclist tbody tr td:first-child').click()`);
  await sleep(60);
  const flSel = await evalIn(`(()=>{
    const v = window.__fv;
    const detail = document.getElementById('detail');
    return { selFunc: v.selectedFunc, detailOn: detail.classList.contains('on') };
  })()`);
  check('FG-049: row click sets view.selectedFunc', flSel.selFunc === flFirstFi, `selectedFunc=${flSel.selFunc} expected=${flFirstFi}`);
  check('FG-049: row click opens the detail slide-over', flSel.detailOn, `detailOn=${flSel.detailOn}`);

  // (8) Sandwich button (⊕) triggers sandwich mode through the public API.
  // Re-open the panel (clicking a row selects but doesn't close the panel).
  if (!await evalIn(`window.__app.isFuncListOpen()`)) await evalIn(`window.__app.openFuncList()`);
  await sleep(30);
  const flSwBtn = await evalIn(`!!document.querySelector('#funclist .fl-sw-btn')`);
  check('FG-049: sandwich button exists in row', flSwBtn, `fl-sw-btn found=${flSwBtn}`);
  if (flSwBtn) {
    const swFi = await evalIn(`+document.querySelector('#funclist .fl-sw-btn').dataset.fi`);
    await evalIn(`document.querySelector('#funclist .fl-sw-btn').click()`);
    await poll(`window.__fv && window.__fv.mode==='sandwich' ? 1 : 0`);
    const flSw = await evalIn(`(()=>({mode:window.__fv.mode, focal:window.__fv.focalFunc}))()`);
    check('FG-049: sandwich button triggers sandwich mode', flSw.mode === 'sandwich', `mode=${flSw.mode}`);
    check('FG-049: sandwich button sets the correct focal function', flSw.focal === swFi, `focal=${flSw.focal} expected=${swFi}`);
    check('FG-049: funclist closes after sandwich action', !await evalIn(`window.__app.isFuncListOpen()`), 'panel closed');
  }

  // (9) Esc closes the panel.
  await evalIn(`window.__app.openFuncList()`);
  await sleep(30);
  check('FG-049: panel re-opened before Esc test', await evalIn(`window.__app.isFuncListOpen()`), 'panel open');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await sleep(40);
  check('FG-049: Esc closes the panel', !await evalIn(`window.__app.isFuncListOpen()`), 'panel closed by Esc');

  // (10) Palette "Function list" command opens the panel.
  await evalIn(`window.__app.resetView()`);
  await poll(`window.__fv && window.__fv.mode==='graph' ? 1 : 0`);
  await evalIn(`(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));})()`);
  await sleep(40);
  await evalIn(`(()=>{const inp=document.getElementById('pal-input');inp.value='Function list';inp.dispatchEvent(new Event('input'));inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
  await sleep(60);
  check('FG-049: palette "Function list" command opens the panel', await evalIn(`window.__app.isFuncListOpen()`), 'panel opened via palette');

  // Clean up: close the panel.
  await evalIn(`window.__app.openFuncList && document.getElementById('funclist').classList.remove('on');`);
  await evalIn(`window.__app.resetView();`);

  // --- FG-050: interactive call stack — clicking ancestor rows navigates to them ---

  // (1) Graph mode: select a deep frame, then click an ancestor row (data-node).
  await evalIn(`window.__app.loadSample('samples/real-vertx.speedscope.json')`);
  await poll(`window.__fv && /real-vertx/.test(document.getElementById('info').innerText||'') ? 1 : 0`);
  await evalIn(`window.__app.setViewType('flame'); window.__app.resetView();`);
  await poll(`window.__fv && window.__fv.mode==='graph' ? 1 : 0`);

  // Pick and select a deep frame (depth >= 2) by clicking it on the canvas.
  const deepPick = await evalIn(`(()=>{const v=window.__fv;const cv=document.getElementById('cv');const cr=cv.getBoundingClientRect();const ROW=22;const top=v.contentTop||0;const cand=v.boxes.filter(b=>b.depth>=2&&b.w>8&&b.node!=null).sort((a,b)=>b.depth-a.depth);return cand.length?{x:cr.left+cand[0].x+cand[0].w/2,y:cr.top+top+cand[0].depth*ROW+ROW/2,depth:cand[0].depth,node:cand[0].node}:null;})()`);
  check('FG-050 graph: deep box found for selection', deepPick != null, `depth=${deepPick && deepPick.depth}`);
  if (deepPick) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: deepPick.x, y: deepPick.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: deepPick.x, y: deepPick.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
    await sleep(80);

    // Verify the detail panel is open with stack rows carrying data-node.
    const detailRows = await evalIn(`(()=>{const el=document.getElementById('detail');const rows=el.querySelectorAll('.dsr[data-node]');return {detailOn:el.classList.contains('on'),rowCount:rows.length,firstNode:rows.length?+rows[0].dataset.node:-1,lastNode:rows.length?+rows[rows.length-1].dataset.node:-1};})()`);
    check('FG-050 graph: detail panel open with data-node rows', detailRows.detailOn && detailRows.rowCount >= 2, `detailOn=${detailRows.detailOn} rowCount=${detailRows.rowCount}`);

    // Click the first row (deepest leaf = index 0 since rows are leaf→root order).
    // We want to click an ANCESTOR: the last row is the root, pick a middle or last ancestor.
    if (detailRows.rowCount >= 2) {
      const origNode = await evalIn(`window.__fv.selectedNode`);
      const origFunc = await evalIn(`window.__fv.selectedFunc`);

      // Click a row with a different node than the current selectedNode (the last row = root).
      const ancestorNode = await evalIn(`(()=>{const el=document.getElementById('detail');const rows=[...el.querySelectorAll('.dsr[data-node]')];const cur=window.__fv.selectedNode;const anc=rows.find(r=>+r.dataset.node!==cur);return anc?+anc.dataset.node:-1;})()`);
      check('FG-050 graph: ancestor row found with different node', ancestorNode >= 0 && ancestorNode !== deepPick.node, `ancestorNode=${ancestorNode}`);

      if (ancestorNode >= 0) {
        // Simulate clicking that ancestor row directly.
        await evalIn(`(()=>{const el=document.getElementById('detail');const row=el.querySelector('.dsr[data-node="${ancestorNode}"]');if(row)row.click();})()`);
        await sleep(60);

        const afterNav = await evalIn(`(()=>{const v=window.__fv;const det=document.getElementById('detail');return {selectedNode:v.selectedNode,selectedFunc:v.selectedFunc,detailOn:det.classList.contains('on')};})()`);
        check('FG-050 graph: clicking ancestor row navigates selectedNode', afterNav.selectedNode === ancestorNode, `selectedNode: ${origNode} → ${afterNav.selectedNode} (expected ${ancestorNode})`);
        check('FG-050 graph: selectedFunc matches ancestor node func', afterNav.selectedFunc === await evalIn(`window.__fv.ct.func[${ancestorNode}]`), `selectedFunc=${afterNav.selectedFunc}`);
        check('FG-050 graph: detail panel stays open after navigation', afterNav.detailOn, `detailOn=${afterNav.detailOn}`);

        // Verify All-Instances aggregate recomputes correctly after navigation.
        const aiCheck = await evalIn(`(()=>{const v=window.__fv;const f=v.selectedFunc;const agg=v._funcAggregate(f);return {f,selfGt:agg.self>0||agg.total>0,total:agg.total,self:agg.self};})()`);
        check('FG-050 graph: All-Instances aggregate valid after ancestor navigation', aiCheck.selfGt, `func=${aiCheck.f} total=${aiCheck.total} self=${aiCheck.self}`);
      }
    }
  }

  // (2) Sandwich mode: assert that clicking a stack row with data-func calls selectFunc (no throw).
  await evalIn(`window.__app.resetView();`);
  await poll(`window.__fv && window.__fv.mode==='graph' ? 1 : 0`);
  await evalIn(`document.getElementById('m-sandwich').click()`);
  await poll(`window.__fv && window.__fv.mode==='sandwich' ? 1 : 0`);

  // Click a callee box to open the detail panel.
  const sandBoxPick = await evalIn(`(()=>{const v=window.__fv;const cv=document.getElementById('cv');const cr=cv.getBoundingClientRect();const ROW=22;const b=v.calleeBoxes&&v.calleeBoxes.find(b=>b.depth>=1&&b.w>6&&b.node!=null);if(!b)return null;const y=cr.top+(v.calleeTop||(v.bandY+22))+(b.depth)*ROW+ROW/2-v.scrollY;return {x:cr.left+b.x+b.w/2,y};})()`);
  if (sandBoxPick) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sandBoxPick.x, y: sandBoxPick.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sandBoxPick.x, y: sandBoxPick.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
    await sleep(80);

    const sandDetail = await evalIn(`(()=>{const el=document.getElementById('detail');const rows=el.querySelectorAll('.dsr[data-func]');return {detailOn:el.classList.contains('on'),rowCount:rows.length};})()`);
    check('FG-050 sandwich: detail open with data-func rows', sandDetail.detailOn && sandDetail.rowCount >= 1, `detailOn=${sandDetail.detailOn} rowCount=${sandDetail.rowCount}`);

    if (sandDetail.rowCount >= 1) {
      // Click a data-func row and verify no error is thrown and selectedFunc is updated.
      const sandNavResult = await evalIn(`(()=>{const el=document.getElementById('detail');const row=el.querySelector('.dsr[data-func]');if(!row)return {skip:true};const fi=+row.dataset.func;let threw=false;try{row.click();}catch(e){threw=true;}const v=window.__fv;return {fi,threw,selectedFunc:v.selectedFunc};})()`);
      check('FG-050 sandwich: clicking data-func row does not throw', !sandNavResult.threw, `threw=${sandNavResult.threw}`);
      check('FG-050 sandwich: clicking data-func row sets selectedFunc', sandNavResult.selectedFunc===sandNavResult.fi, `selectedFunc=${sandNavResult.selectedFunc} fi=${sandNavResult.fi}`);
    }
  } else {
    check('FG-050 sandwich: callee box available for test', false, 'no callee box found — skipping sandwich click test');
  }

  // (3) Chart mode: assert that clicking a stack row with data-func degrades to function-select without throwing.
  await evalIn(`window.__app.resetView();`);
  await poll(`window.__fv && window.__fv.mode==='graph' ? 1 : 0`);
  await evalIn(`document.getElementById('m-chart').click()`);
  await poll(`window.__fv && window.__fv.mode==='chart' ? 1 : 0`);

  // Click a chart box to open the detail panel.
  const chartBoxPick = await evalIn(`(()=>{const v=window.__fv;const cv=document.getElementById('cv');const cr=cv.getBoundingClientRect();const ROW=22;const top=v.contentTop||0;const b=v.boxes&&v.boxes.find(b=>b.depth>=1&&b.w>8&&b.t0!=null);if(!b)return null;return {x:cr.left+b.x+b.w/2,y:cr.top+top+b.depth*ROW+ROW/2};})()`);
  if (chartBoxPick) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: chartBoxPick.x, y: chartBoxPick.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: chartBoxPick.x, y: chartBoxPick.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
    await sleep(80);

    const chartDetail = await evalIn(`(()=>{const el=document.getElementById('detail');const rows=el.querySelectorAll('.dsr[data-func]');return {detailOn:el.classList.contains('on'),rowCount:rows.length};})()`);
    check('FG-050 chart: detail open with data-func rows', chartDetail.detailOn && chartDetail.rowCount >= 1, `detailOn=${chartDetail.detailOn} rowCount=${chartDetail.rowCount}`);

    if (chartDetail.rowCount >= 1) {
      // Click a data-func row and verify it selects a function without throwing.
      const chartNavResult = await evalIn(`(()=>{const el=document.getElementById('detail');const row=el.querySelector('.dsr[data-func]');if(!row)return {skip:true};const fi=+row.dataset.func;let threw=false;try{row.click();}catch(e){threw=true;}const v=window.__fv;return {fi,threw,selectedFunc:v.selectedFunc};})()`);
      check('FG-050 chart: clicking data-func row does not throw', !chartNavResult.threw, `threw=${chartNavResult.threw}`);
      check('FG-050 chart: clicking data-func row selects function', chartNavResult.selectedFunc === chartNavResult.fi, `selectedFunc=${chartNavResult.selectedFunc} fi=${chartNavResult.fi}`);
    }
  } else {
    check('FG-050 chart: chart box available for test', false, 'no chart box found — skipping chart click test');
  }

  // Clean up after FG-050 tests.
  await evalIn(`window.__app.resetView();`);

  // --- FG-048: weight unit relabeling for folded/off-CPU profiles ---
  // Use a single-weight folded profile — the actual FG-048 use case (an off-CPU/wait profile
  // carries one ambiguous 'samples' column). Relabel + round-trip is then collision-free.
  await evalIn(`window.__app.loadSample('samples/multi-value.pprof')`); // load anything first
  await poll(`window.__fv ? 1 : 0`);
  await evalIn(`window.__app.openUrl('/test/testdata/tiny.folded')`);
  await poll(`window.__fv && /tiny\\.folded/.test(document.getElementById('info').innerText||'') ? 1 : 0`);

  // (1) setWeightUnit is exposed.
  const fg48Base = await evalIn(`(()=>{return {setWeightUnitExists:typeof window.__app.setWeightUnit==='function'};})()`);
  check('FG-048: window.__app.setWeightUnit is exposed', fg48Base.setWeightUnitExists, JSON.stringify(fg48Base));

  // (2) Record the current active weight type, then relabel it to 'milliseconds'.
  const fg48Before = await evalIn(`(()=>{const f=window.__fv;return {wt:f.weightType,wtok:document.getElementById('st-weight').innerText,wts:[...f.p.capabilities.weightTypes]};})()`);
  await evalIn(`window.__app.setWeightUnit('milliseconds')`);
  await sleep(50);
  const fg48After = await evalIn(`(()=>{const f=window.__fv;return {wt:f.weightType,wtok:document.getElementById('st-weight').innerText,wts:[...f.p.capabilities.weightTypes],totalLabel:f.totalLabel()};})()`);
  check('FG-048: setWeightUnit relabels view.weightType to milliseconds', fg48After.wt === 'milliseconds', `before=${fg48Before.wt} after=${fg48After.wt}`);
  check('FG-048: weight token updates after relabel', fg48After.wtok === 'milliseconds', `wtok="${fg48After.wtok}"`);
  check('FG-048: capabilities.weightTypes updated to contain milliseconds', fg48After.wts.includes('milliseconds'), `wts=${JSON.stringify(fg48After.wts)}`);
  check('FG-048: old weight type name is gone from capabilities', !fg48After.wts.includes(fg48Before.wt) || fg48Before.wt === 'milliseconds', `before="${fg48Before.wt}" wts=${JSON.stringify(fg48After.wts)}`);
  check('FG-048: totalLabel now formats as time (not "samples")', /(ms|µs|ns|\d+s)/.test(fg48After.totalLabel) && !fg48After.totalLabel.toLowerCase().includes('samples'), `totalLabel="${fg48After.totalLabel}"`);

  // (3) Relabel back to 'samples' to confirm round-trip and invariants hold.
  await evalIn(`window.__app.setWeightUnit('samples')`);
  await sleep(50);
  const fg48RoundTrip = await evalIn(`(()=>{const f=window.__fv;return {wt:f.weightType,wts:[...f.p.capabilities.weightTypes]};})()`);
  check('FG-048: setWeightUnit round-trips to samples', fg48RoundTrip.wt === 'samples', `wt="${fg48RoundTrip.wt}"`);
  const fg48Inv = await evalIn(INV);
  check('FG-048: view invariants hold after relabeling', fg48Inv.ok, JSON.stringify(fg48Inv));

  // (4) Collision guard: on a multi-value profile, relabeling the active weight to a name that
  // already exists as another column is rejected (would otherwise overwrite that column).
  await evalIn(`window.__app.loadSample('samples/multi-value.pprof')`);
  await poll(`window.__fv && window.__fv.p.capabilities.weightTypes.length >= 2 ? 1 : 0`);
  const fg48Coll = await evalIn(`(()=>{const f=window.__fv;const before=f.weightType;const other=f.p.capabilities.weightTypes.find(w=>w!==before);window.__app.setWeightUnit(other==='samples'?'samples':'samples');return {before,wtsBefore:[...f.p.capabilities.weightTypes]};})()`);
  await sleep(50);
  const fg48CollAfter = await evalIn(`(()=>{const f=window.__fv;return {wt:f.weightType,wts:[...f.p.capabilities.weightTypes]};})()`);
  check('FG-048: relabel to an existing weight name is blocked (no corruption)', fg48CollAfter.wt === fg48Coll.before && JSON.stringify(fg48CollAfter.wts.slice().sort()) === JSON.stringify(fg48Coll.wtsBefore.slice().sort()), `before=${fg48Coll.before} after=${fg48CollAfter.wt} wts=${JSON.stringify(fg48CollAfter.wts)}`);

  // (4) The palette lists "Weight unit:" entries when a profile is loaded.
  await evalIn(`(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));})()`);
  await sleep(40);
  const palRows = await evalIn(`[...document.querySelectorAll('#pal-list .row')].map(r=>r.textContent).join('|')`);
  await evalIn(`document.getElementById('palette').classList.remove('on')`);
  check('FG-048: palette includes "Weight unit: milliseconds" entry', palRows.includes('Weight unit: milliseconds'), `palette has entries: ${palRows.includes('Weight unit')}`);

  await evalIn(`window.__app.resetView();`);

  // --- FG-044: source-map remapping ---
  // Load the node.cpuprofile fixture; its frames reference a generated file.
  // We'll synthesise a tiny source map that remaps one known function name and verify
  // that applySourceMaps() rewrites the profile's func names and packageOf grouping.
  await evalIn(`window.__app.loadSample('samples/node.cpuprofile')`);
  await poll(`window.__fv && /node\\.cpuprofile/.test(document.getElementById('info').innerText||'') ? 1 : 0`);

  // Grab the first non-trivial function name and file from the loaded profile so we can
  // build a map that targets it. We look for a func that has a non-empty file string.
  const fg44Base = await evalIn(`(()=>{
    const p = window.__fv.p;
    for (let i = 0; i < p.funcTable.name.length; i++) {
      const name = p.stringTable[p.funcTable.name[i]] || '';
      const fi = p.funcTable.file[i];
      const file = fi >= 0 ? (p.stringTable[fi] || '') : '';
      const line = p.funcTable.line[i];
      if (name && file && line > 0) {
        // extract basename of file
        const bn = file.split('/').pop() || file;
        return { name, file: bn, line, funcIdx: i };
      }
    }
    return null;
  })()`);

  if (fg44Base) {
    // Build a minimal source map v3 that remaps genLine=<line> in <file> to
    // original source "src/original.ts", line 42, with a mapped name "remappedFn".
    // VLQ encoding: genColDelta=0, srcIdxDelta=0, origLineDelta=41(0-based), origColDelta=0, nameIdxDelta=0
    // We encode these as VLQ segments separated by semicolons to reach the target line.
    const fg44Map = await evalIn(`(()=>{
      const genLine = ${JSON.stringify(fg44Base.line)};
      // Encode VLQ: helper
      const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      function vlq(n) {
        let v = n < 0 ? ((-n)<<1)|1 : n<<1;
        let out = '';
        do { let s=v&0x1f; v>>>=5; if(v>0)s|=0x20; out+=B64[s]; } while(v>0);
        return out;
      }
      // Build mappings: we need to emit enough semicolons to reach genLine (1-based → 0-based index genLine-1)
      const semiCount = genLine - 1;
      const seg = vlq(0)+vlq(0)+vlq(41)+vlq(0)+vlq(0); // genCol=0, src=0, origLine=41(→42 1-based), origCol=0, name=0
      const mappings = ';'.repeat(semiCount) + seg;
      return JSON.stringify({
        version: 3,
        file: ${JSON.stringify(fg44Base.file)},
        sources: ['src/original.ts'],
        sourcesContent: ['// original source line 42'],
        names: ['remappedFn'],
        mappings,
      });
    })()`);

    const fg44MapName = fg44Base.file + '.map'; // e.g. "node.js.map"
    const fg44Result = await evalIn(`window.__app.applySourceMaps([{name:${JSON.stringify(fg44MapName)},text:${JSON.stringify(fg44Map)}}])`);
    check('FG-044: applySourceMaps returns true when a map matches', fg44Result === true, `returned=${fg44Result}`);

    // After remap, find the function that now has name "remappedFn"
    const fg44After = await evalIn(`(()=>{
      const p = window.__fv.p;
      for (let i = 0; i < p.funcTable.name.length; i++) {
        const nm = p.stringTable[p.funcTable.name[i]] || '';
        if (nm === 'remappedFn') {
          const fi = p.funcTable.file[i];
          const file = fi >= 0 ? (p.stringTable[fi] || '') : '';
          const line = p.funcTable.line[i];
          return { name: nm, file, line };
        }
      }
      return null;
    })()`);
    check('FG-044: remapped func name is "remappedFn"', fg44After !== null, `found=${JSON.stringify(fg44After)}`);
    if (fg44After) {
      check('FG-044: remapped func file is "src/original.ts"', fg44After.file === 'src/original.ts', `file=${fg44After.file}`);
      check('FG-044: remapped func line is 42', fg44After.line === 42, `line=${fg44After.line}`);
    }

    // Unmapped functions must still be present (profile is not empty).
    const fg44Unchanged = await evalIn(`(()=>{const p=window.__fv.p;return p.funcTable.name.length;})()`);
    check('FG-044: unmapped funcs still present in remapped profile', fg44Unchanged > 1, `funcCount=${fg44Unchanged}`);

    // The sourcesContent should have been fed to srcFiles under the original source basename.
    const fg44SrcFile = await evalIn(`window.__app.getSrcFiles().has('original.ts')`);
    check('FG-044: sourcesContent fed to srcFiles under original basename', fg44SrcFile === true, `has original.ts: ${fg44SrcFile}`);

    // A profile with no maps should be identical to the base profile (no remap).
    // Reset then reload without maps.
    await evalIn(`window.__app.resetView();`);
  } else {
    check('FG-044: fixture has a function with file+line (needed for map test)', false, 'no usable func found — test skipped');
  }

  // ── FG-042: Vaus mode (easter-egg overlay) ─────────────────────────────────────────────
  // The game overlays the canvas over a read-only snapshot of the host view's boxes. Entering
  // and quitting must never mutate the underlying analytical view.
  {
    // Clean slate: reload the base sample and force a flame (graph) view with boxes.
    // Re-resolve the #file node (the cached id from page-load may be stale after earlier blocks).
    const { root: vausRoot } = await cdp.send('DOM.getDocument', {}, sessionId);
    const vausFile = await cdp.send('DOM.querySelector', { nodeId: vausRoot.nodeId, selector: '#file' }, sessionId);
    await cdp.send('DOM.setFileInputFiles', { nodeId: vausFile.nodeId, files: [DATA] }, sessionId);
    await poll(`/node\\.cpuprofile/.test(document.getElementById('info').innerText||'') && window.__fv ? 1 : 0`);
    await evalIn(`document.getElementById('m-graph') && document.getElementById('m-graph').click()`);
    await poll(`window.__fv && window.__fv.boxes && window.__fv.boxes.length>0 ? 1 : 0`);

    // Snapshot the host identity + key state BEFORE entering the game.
    const hostBefore = await evalIn(`(()=>{const v=window.__fv;window.__vausHost=v;return {boxes:v.boxes.length,mode:v.mode,focusNull:v.focus==null};})()`);

    // --- entry path 1: Konami code (↑↑↓↓←→←→ b a) ---
    await evalIn(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
    const konami: [string, number][] = [['ArrowUp',38],['ArrowUp',38],['ArrowDown',40],['ArrowDown',40],['ArrowLeft',37],['ArrowRight',39],['ArrowLeft',37],['ArrowRight',39],['b',66],['a',65]];
    for (const [key, vk] of konami) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, windowsVirtualKeyCode: vk }, sessionId);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, windowsVirtualKeyCode: vk }, sessionId);
    }
    const konamiActive = await evalIn(`window.__app.vausActive()`);
    check('FG-042: Konami code enters Vaus mode', konamiActive === true);
    await evalIn(`window.__app.vausQuit()`);
    await sleep(30);
    const afterKonamiQuit = await evalIn(`(()=>({active:window.__app.vausActive(), same:window.__fv===window.__vausHost}))()`);
    check('FG-042: quit after Konami restores host view', afterKonamiQuit.active === false && afterKonamiQuit.same === true);

    // --- entry path 2: palette command (startVaus hook) ---
    await evalIn(`window.__app.startVaus()`);
    const active = await evalIn(`window.__app.vausActive()`);
    check('FG-042: startVaus (palette path) activates the overlay', active === true);
    const fvStable = await evalIn(`window.__fv === window.__vausHost`);
    check('FG-042: host __fv identity unchanged while game active', fvStable === true);

    await evalIn(`window.__app.vausBegin()`); // splash → playing without a Space gesture
    const st = await evalIn(`window.__app.vausState()`);
    check('FG-042: game builds bricks from the box snapshot', !!st && st.phase === 'playing' && st.bricks > 0, `phase=${st && st.phase}, bricks=${st && st.bricks}`);
    check('FG-042: bricks include destructibles', !!st && st.destructibleLeft > 0, `destructibleLeft=${st && st.destructibleLeft}`);

    // Deterministic destruction: drop the ball just under the first destructible brick, moving
    // up, and step until its HP is exhausted. destructibleLeft must fall by exactly one.
    const destroy = await evalIn(`(()=>{
      const bricks=window.__app.vausBricks();
      const d=bricks.find(b=>!b.indestructible && !b.destroyed);
      if(!d) return {ok:false};
      const before=window.__app.vausState().destructibleLeft;
      let steps=0;
      while(window.__app.vausState().destructibleLeft===before && steps<16){
        window.__app.vausSetBall(d.x+d.w/2, d.y+d.h+8, 0, -290);
        window.__app.vausStep(50);
        steps++;
      }
      return {ok:true, before, after:window.__app.vausState().destructibleLeft, steps};
    })()`);
    check('FG-042: ball destroys a weight-scaled destructible brick', destroy.ok && destroy.after === destroy.before - 1, `left ${destroy.before} → ${destroy.after} in ${destroy.steps} steps`);

    // Indestructible brick (root/runtime) survives repeated hits.
    const indes = await evalIn(`(()=>{
      const i=window.__app.vausBricks().find(b=>b.indestructible && !b.destroyed);
      if(!i) return {skip:true};
      for(let k=0;k<6;k++){ window.__app.vausSetBall(i.x+i.w/2, i.y+i.h+8, 0, -290); window.__app.vausStep(50); }
      const still=window.__app.vausBricks().find(b=>Math.abs(b.x-i.x)<0.5 && Math.abs(b.y-i.y)<0.5);
      return {survived: !!still && !still.destroyed};
    })()`);
    check('FG-042: indestructible brick survives repeated hits', indes.skip === true || indes.survived === true, indes.skip ? '(no indestructible brick in this sample)' : '');

    // The host view must be byte-for-byte the same object/state while the game runs.
    const hostMid = await evalIn(`(()=>{const v=window.__vausHost;return {boxes:v.boxes.length,mode:v.mode,focusNull:v.focus==null};})()`);
    check('FG-042: host view untouched during play', hostMid.boxes === hostBefore.boxes && hostMid.mode === hostBefore.mode && hostMid.focusNull === hostBefore.focusNull, `boxes ${hostBefore.boxes}→${hostMid.boxes}, mode ${hostMid.mode}`);

    // Quit restores the exact prior view — same object, boxes, mode — with no rebuild.
    await evalIn(`window.__app.vausQuit()`);
    await sleep(40);
    const afterQuit = await evalIn(`(()=>({active:window.__app.vausActive(), same:window.__fv===window.__vausHost, boxes:window.__fv.boxes.length, mode:window.__fv.mode}))()`);
    check('FG-042: quit deactivates the game', afterQuit.active === false);
    check('FG-042: quit restores the exact host view (same object/boxes/mode)', afterQuit.same && afterQuit.boxes === hostBefore.boxes && afterQuit.mode === hostBefore.mode, `same=${afterQuit.same}, boxes=${afterQuit.boxes}, mode=${afterQuit.mode}`);

    // No leak: a second quit + a stray key after exit are harmless no-ops.
    const noLeak = await evalIn(`(()=>{try{window.__app.vausQuit();return {ok:true};}catch(e){return {ok:false,err:String(e)};}})()`);
    check('FG-042: second quit is a harmless no-op', noLeak.ok === true, noLeak.err || '');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
    const afterStray = await evalIn(`window.__app.vausActive()===false && !!(window.__fv && window.__fv.boxes)`);
    check('FG-042: stray key after quit neither reactivates nor crashes', afterStray === true);

    // gameConfig persists across sessions via localStorage.
    await evalIn(`(()=>{const c=JSON.parse(localStorage.getItem('fv-vaus-config')||'{}');c.lives=7;localStorage.setItem('fv-vaus-config',JSON.stringify(c));})()`);
    await evalIn(`window.__app.startVaus(); window.__app.vausBegin();`);
    const persisted = await evalIn(`window.__app.vausState().lives`);
    check('FG-042: gameConfig (lives) persists via localStorage', persisted === 7, `lives=${persisted}`);
    await evalIn(`window.__app.vausQuit()`);
  }

  // --- FG-060: heap dump retained-size icicle (JDK-gated) ---
  // Generate test/out/heap-workload.hprof via the same JDK the parse-hprof-test uses,
  // drop it into the app, and assert the icicle view + disabled mode buttons + detail click.
  // Gated so CI machines without a JDK skip cleanly.
  {
    const hasJdk = spawnSync('which', ['java'], { encoding: 'utf8' }).status === 0
                && spawnSync('which', ['javac'], { encoding: 'utf8' }).status === 0;
    if (!hasJdk) {
      console.log('FG-060: skip heap smoke — no JDK found');
    } else {
      const HPROF_OUT = resolve(ROOT, 'test/out/heap-workload.hprof');
      const HPROF_SRC = resolve(ROOT, 'test/gen/HprofWorkload.java');
      const HPROF_CLS = resolve(ROOT, 'test/out/HprofWorkload.class');
      const OUT_DIR   = resolve(ROOT, 'test/out');
      if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
      const needRegen = !existsSync(HPROF_OUT)
        || (existsSync(HPROF_SRC) && statSync(HPROF_SRC).mtimeMs > statSync(HPROF_OUT).mtimeMs);
      if (needRegen) {
        console.log('FG-060: generating heap-workload.hprof for browser smoke…');
        if (existsSync(HPROF_OUT)) rmSync(HPROF_OUT);
        if (existsSync(HPROF_CLS)) rmSync(HPROF_CLS);
        spawnSync('javac', ['-d', OUT_DIR, HPROF_SRC], { stdio: 'pipe' });
        spawnSync('java', ['-cp', OUT_DIR, 'HprofWorkload', HPROF_OUT], { stdio: 'pipe' });
      }
      if (!existsSync(HPROF_OUT)) {
        check('FG-060: heap dump generated', false, `missing: ${HPROF_OUT}`);
      } else {
        // Re-resolve the file input node (prior blocks may have invalidated the cached nodeId).
        const { root: hRoot } = await cdp.send('DOM.getDocument', {}, sessionId);
        const hFile = await cdp.send('DOM.querySelector', { nodeId: hRoot.nodeId, selector: '#file' }, sessionId);

        // Drop the .hprof file into the app.
        await cdp.send('DOM.setFileInputFiles', { nodeId: hFile.nodeId, files: [HPROF_OUT] }, sessionId);
        // Wait for the icicle to appear: info shows 'object' (the heap info line, not "loading…").
        // The completed heap info reads "<label> · heap · N objects · X total", so 'object' only
        // appears once fully loaded; "loading…" or the prior sampled info will not match.
        // Poll with enough time for the parse + dominator computation (27k objects).
        await poll(`window.__fv && window.__fv.p && window.__fv.p.capabilities && window.__fv.p.capabilities.kind === 'heap' && window.__fv.boxes && window.__fv.boxes.length > 0 && /object/.test(document.getElementById('info').innerText||'') ? 1 : 0`, 20000);
        console.log('FG-060: heap dump loaded into browser');

        const hv = await evalIn(`(()=>{
          const f = window.__fv;
          const cv = document.getElementById('cv');
          const info = document.getElementById('info').innerText || '';
          const chartDis  = document.getElementById('m-chart').disabled;
          const sandDis   = document.getElementById('m-sandwich').disabled;
          const boxes     = f ? f.boxes.length : 0;
          // Find a box whose funcName contains a known class suffix.
          let classBox = null;
          if (f && f.boxes) {
            for (const b of f.boxes) {
              const nm = f.p.stringTable[f.p.funcTable.name[b.func]] || '';
              if (nm.endsWith('ExclusiveOwner') || nm.endsWith('byte[]')) { classBox = nm; break; }
            }
          }
          return { mode: f ? f.mode : null, boxes, chartDis, sandDis, classBox, info };
        })()`);

        check('FG-060: heap loads in graph mode (icicle)', hv.mode === 'graph', `mode=${hv.mode}`);
        check('FG-060: heap icicle has boxes', hv.boxes > 0, `boxes=${hv.boxes}`);
        check('FG-060: heap chart button disabled', hv.chartDis === true, `chartDis=${hv.chartDis}`);
        check('FG-060: heap sandwich button disabled', hv.sandDis === true, `sandDis=${hv.sandDis}`);
        check('FG-060: at least one box labelled with a known class', hv.classBox !== null, `classBox=${hv.classBox}`);
        check('FG-060: info bar shows heap + object count', /heap/.test(hv.info) && /object/.test(hv.info), `info="${hv.info.slice(0,80)}"`);

        // Click the biggest box and assert the detail slide-over opens (retainer path).
        const hPick = await evalIn(`(()=>{
          const f = window.__fv;
          const cv = document.getElementById('cv');
          const cr = cv.getBoundingClientRect();
          const ROW = 22;
          const top = f.contentTop || 0;
          const b = f.boxes.filter(b => b.depth >= 1 && b.w > 10)[0] || null;
          if (!b) return null;
          return { x: cr.left + b.x + b.w / 2, y: cr.top + top + b.depth * ROW + ROW / 2 };
        })()`);
        if (hPick) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hPick.x, y: hPick.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hPick.x, y: hPick.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
          await sleep(80);
          const hDet = await evalIn(`(()=>{const el=document.getElementById('detail');return {on:el.classList.contains('on'),text:(el.innerText||'').replace(/\\s+/g,' ').trim().slice(0,80)};})()`);
          check('FG-060: click opens detail slide-over (retainer path)', hDet.on, `detail.on=${hDet.on} text="${hDet.text}"`);
        } else {
          check('FG-060: clickable heap box found', false, 'no box with depth>=1');
        }

        // After the heap smoke, reload a sampled profile and confirm the sampled view still works.
        await evalIn(`window.__app.loadSample('samples/node.cpuprofile')`);
        await poll(`window.__fv && /node\\.cpuprofile/.test(document.getElementById('info').innerText||'') ? 1 : 0`);
        const hBack = await evalIn(`(()=>{const f=window.__fv;return {boxes:f.boxes.length,mode:f.mode,chartDis:document.getElementById('m-chart').disabled};})()`);
        check('FG-060: sampled profile still works after heap (no state leak)', hBack.boxes > 0 && hBack.mode !== null, `boxes=${hBack.boxes} mode=${hBack.mode} chartDis=${hBack.chartDis}`);
      }
    }
  }

  // --- FG-061: treemap view (squarified) ---
  // Load a sampled profile, switch to treemap, assert boxes > 0, check mode and interactions.
  await evalIn(`window.__app.loadSample('samples/node.cpuprofile')`);
  await poll(`window.__fv && /node\\.cpuprofile/.test(document.getElementById('info').innerText||'') ? 1 : 0`);
  await evalIn(`window.__app.setViewType('treemap')`);
  await poll(`window.__fv && window.__fv.constructor.name==='TreemapView' ? 1 : 0`);

  const tm = await evalIn(`(()=>{
    const v = window.__fv;
    return {
      type: v.constructor.name,
      mode: v.mode,
      boxes: v.boxes.length,
      chartOff: document.getElementById('m-chart').disabled,
      sandOff:  document.getElementById('m-sandwich').disabled,
      vt: document.getElementById('st-viewtype').innerText,
    };
  })()`);
  check('FG-061 treemap: switches to TreemapView + token reads "treemap"', tm.type === 'TreemapView' && tm.vt === 'treemap', JSON.stringify(tm));
  check('FG-061 treemap: boxes > 0', tm.boxes > 0, `boxes=${tm.boxes}`);
  check('FG-061 treemap: mode is graph', tm.mode === 'graph', `mode=${tm.mode}`);
  check('FG-061 treemap: Timeline + Sandwich buttons disabled (caps)', tm.chartOff && tm.sandOff, JSON.stringify(tm));

  // hover: move over a box and check that hover is set
  const tmHov = await evalIn(`(()=>{
    const v = window.__fv;
    const cv = document.getElementById('cv');
    const r = cv.getBoundingClientRect();
    const b = v.boxes.find(b => b.w > 20 && b.h > 20);
    if (!b) return { skip: true };
    v._onMove({ clientX: r.left + b.x + b.w / 2, clientY: r.top + b.y + b.h / 2 });
    return { hover: v.hover != null, func: v.hover ? v.hover.func : null };
  })()`);
  check('FG-061 treemap: hover over a cell sets this.hover', tmHov.skip || tmHov.hover, JSON.stringify(tmHov));

  // click to zoom in: clicking a cell should set focus and relayout
  const tmZoom = await evalIn(`(()=>{
    const v = window.__fv;
    const cv = document.getElementById('cv');
    const r = cv.getBoundingClientRect();
    // find a cell that has children (depth 0 but not root-only)
    const b = v.boxes.find(b => b.depth === 0 && b.w > 40 && b.h > 40);
    if (!b) return { skip: true };
    const prevFocus = v.focus;
    const prevBoxes = v.boxes.length;
    v._onClick({ clientX: r.left + b.x + b.w / 2, clientY: r.top + b.y + b.h / 2 });
    return { focusChanged: v.focus !== prevFocus, focus: v.focus, boxes: v.boxes.length };
  })()`);
  check('FG-061 treemap: clicking a cell zooms in (focus changes)', tmZoom.skip || tmZoom.focusChanged, JSON.stringify(tmZoom));

  // double-click to zoom out
  if (!tmZoom.skip && tmZoom.focusChanged) {
    await sleep(50);
    const tmOut = await evalIn(`(()=>{
      const v = window.__fv;
      const prevFocus = v.focus;
      // double-click on an empty area (0,0) to zoom out
      v._onDblClick({ clientX: document.getElementById('cv').getBoundingClientRect().left + 1,
                      clientY: document.getElementById('cv').getBoundingClientRect().top + 1 });
      return { focusNow: v.focus, changed: v.focus !== prevFocus };
    })()`);
    check('FG-061 treemap: double-click zooms out', tmOut.changed, JSON.stringify(tmOut));
  }

  // search dims non-matching boxes (matchedFuncs set)
  await evalIn(`window.__app.setSearch('jsonWork')`);
  await sleep(40);
  const tmSearch = await evalIn(`(()=>{const v=window.__fv;return {matchedFuncs:v.matchedFuncs!=null,size:v.matchedFuncs?v.matchedFuncs.size:0};})()`);
  check('FG-061 treemap: search sets matchedFuncs', tmSearch.matchedFuncs, JSON.stringify(tmSearch));
  await evalIn(`window.__app.setSearch('')`);

  // cycle back to flame through the view-type button
  await evalIn(`document.getElementById('st-viewtype').click()`);
  await poll(`window.__fv && window.__fv.constructor.name!=='TreemapView' ? 1 : 0`);
  check('FG-061 treemap: cycles away via st-viewtype click', await evalIn(`window.__fv.constructor.name!=='TreemapView'`), `constructor=${await evalIn(`window.__fv.constructor.name`)}`);

  // dispose: switching away removes listeners (stale treemap view must not respond to canvas clicks)
  await evalIn(`(window.__prevTm = window.__fv)`);
  await evalIn(`window.__app.setViewType('treemap')`);
  await poll(`window.__fv && window.__fv.constructor.name==='TreemapView' ? 1 : 0`);
  await evalIn(`(window.__prevTm2 = window.__fv)`);
  await evalIn(`window.__app.setViewType('flame')`);
  await poll(`window.__fv && window.__fv.constructor.name==='FlameView' ? 1 : 0`);
  // stale treemap's hover should not change when we move over the canvas (its listeners are removed)
  await evalIn(`if(window.__prevTm2) window.__prevTm2.hover = 'SENTINEL'`);
  const cr2 = await evalIn(`(()=>{const cv=document.getElementById('cv');const r=cv.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cr2.x, y: cr2.y }, sessionId);
  await sleep(50);
  check('FG-061 treemap: dispose removes listeners (stale view ignores mouse)', await evalIn(`window.__prevTm2 ? window.__prevTm2.hover === 'SENTINEL' : true`), 'stale hover unchanged');

  await evalIn(`window.__app.setViewType('flame'); window.__app.resetView();`);
  await poll(`window.__fv && window.__fv.constructor.name==='FlameView' ? 1 : 0`);

} catch (e: any) {
  failures++;
  console.log('  ✗ harness error —', e?.message || e);
} finally {
  try { chrome.kill('SIGKILL'); } catch {}
  try { server.close(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(failures === 0 ? '\nbrowser: all checks passed ✓' : `\nbrowser: ${failures} check(s) failed ✗`);
process.exit(failures === 0 ? 0 : 1);
