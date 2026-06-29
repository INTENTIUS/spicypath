// Programmatic tests for FG-028 Slice B adapters: debugPprofAdapter, pyroscopeAdapter,
// parcaAdapter. Runs under Node (no browser) against the mock server.
//   node test/adapters-test.ts
import { startMockPprofServer } from './mock-pprof-server.ts';
import { debugPprofAdapter } from '../src/fetch-pprof.js';
import { pyroscopeAdapter }  from '../src/source-pyroscope.js';
import { parcaAdapter }      from '../src/source-parca.js';
import type { Profile } from '../src/model.ts';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
}

function hasBoxes(p: Profile): boolean {
  // A Profile has at least one thread and at least one sample with a non-negative stack.
  if (!p || !p.threads || p.threads.length === 0) return false;
  const t = p.threads[0];
  return t.samples.stack.some((s: number) => s >= 0);
}

const srv = await startMockPprofServer();
try {
  // ---- debugPprofAdapter ----
  console.log('\ndebugPprofAdapter:');

  // happy path
  const debugProfile = await debugPprofAdapter.fetchProfile({
    url: `${srv.url}/debug/pprof/profile`,
    seconds: 7,
  }) as Profile;
  check('returns a Profile with samples', hasBoxes(debugProfile));
  check('mock received ?seconds=7', srv.lastSeconds === '7', `lastSeconds=${srv.lastSeconds}`);
  check('fetchCount incremented', srv.fetchCount === 1, `fetchCount=${srv.fetchCount}`);

  // describe
  const desc = debugPprofAdapter.describe({ url: 'http://localhost:6060/debug/pprof/profile', seconds: 5 });
  check('describe() returns a non-empty string', typeof desc === 'string' && desc.length > 0, desc);

  // non-OK response throws (use a 404 path)
  let threw = false;
  try { await debugPprofAdapter.fetchProfile({ url: `${srv.url}/notfound`, seconds: 1 }); }
  catch { threw = true; }
  check('non-OK response throws (not a wedged promise)', threw);

  // missing url throws
  let threwMissing = false;
  try { await debugPprofAdapter.fetchProfile({}); }
  catch { threwMissing = true; }
  check('missing url throws synchronously', threwMissing);

  // ---- pyroscopeAdapter ----
  console.log('\npyroscopeAdapter:');

  const now = Math.floor(Date.now() / 1000);
  const pyroOpts = {
    baseUrl: srv.url,
    query:   'myapp.cpu{}',
    from:    now - 3600,
    until:   now,
  };

  const pyroProfile = await pyroscopeAdapter.fetchProfile(pyroOpts) as Profile;
  check('returns a Profile with samples', hasBoxes(pyroProfile));
  check('pyroscopeFetchCount incremented', srv.pyroscopeFetchCount === 1, `count=${srv.pyroscopeFetchCount}`);

  const pp = srv.lastPyroscopeParams;
  check('query param forwarded', pp?.query === 'myapp.cpu{}', `query=${pp?.query}`);
  check('from param forwarded', pp?.from === String(now - 3600), `from=${pp?.from}`);
  check('until param forwarded', pp?.until === String(now), `until=${pp?.until}`);
  check('format=pprof sent', pp?.format === 'pprof', `format=${pp?.format}`);

  // profile is reusing parsePprofBytes path — verify capabilities shape
  check('capabilities.weightTypes is an array', Array.isArray(pyroProfile.capabilities.weightTypes));

  const pyroDesc = pyroscopeAdapter.describe(pyroOpts);
  check('describe() includes host + query', typeof pyroDesc === 'string' && pyroDesc.includes('127.0.0.1') && pyroDesc.includes('myapp.cpu{}'), pyroDesc);

  // non-OK throws
  let pyroBad = false;
  try { await pyroscopeAdapter.fetchProfile({ ...pyroOpts, baseUrl: srv.url, query: undefined as any }); }
  catch { pyroBad = true; }
  check('missing query throws', pyroBad);

  let pyroHttpErr = false;
  try { await pyroscopeAdapter.fetchProfile({ ...pyroOpts, baseUrl: `http://127.0.0.1:1` }); }
  catch { pyroHttpErr = true; }
  check('connection refused throws (not a wedged promise)', pyroHttpErr);

  // ---- parcaAdapter ----
  console.log('\nparcaAdapter:');

  const nowMs = Date.now();
  const parcaOpts = {
    baseUrl: srv.url,
    query:   'process_cpu:cpu:nanoseconds:cpu:nanoseconds{job="svc"}',
    from:    nowMs - 3_600_000,
    until:   nowMs,
  };

  const parcaProfile = await parcaAdapter.fetchProfile(parcaOpts) as Profile;
  check('returns a Profile with samples', hasBoxes(parcaProfile));
  check('parcaFetchCount incremented', srv.parcaFetchCount === 1, `count=${srv.parcaFetchCount}`);

  const cp = srv.lastParcaParams;
  check('query param forwarded', cp?.query === 'process_cpu:cpu:nanoseconds:cpu:nanoseconds{job="svc"}', `query=${cp?.query}`);
  check('start param forwarded', cp?.start === String(nowMs - 3_600_000), `start=${cp?.start}`);
  check('end param forwarded', cp?.end === String(nowMs), `end=${cp?.end}`);

  check('capabilities.weightTypes is an array', Array.isArray(parcaProfile.capabilities.weightTypes));

  const parcaDesc = parcaAdapter.describe(parcaOpts);
  check('describe() includes host + query', typeof parcaDesc === 'string' && parcaDesc.includes('127.0.0.1') && parcaDesc.includes('process_cpu'), parcaDesc);

  let parcaBad = false;
  try { await parcaAdapter.fetchProfile({ ...parcaOpts, from: undefined as any }); }
  catch { parcaBad = true; }
  check('missing from throws', parcaBad);

  let parcaHttpErr = false;
  try { await parcaAdapter.fetchProfile({ ...parcaOpts, baseUrl: `http://127.0.0.1:1` }); }
  catch { parcaHttpErr = true; }
  check('connection refused throws (not a wedged promise)', parcaHttpErr);

  // The mock serves Parca's Connect-JSON envelope { pprof: base64 }; the passing Profile
  // above proves the base64→bytes→gunzip→parse unwrap end-to-end (not a raw-bytes strawman).
  // Also exercise the envelope primitive directly: base64 of a gzip body decodes to gzip magic.
  const { base64ToBytes } = await import('../src/source-adapter.js');
  const magic = base64ToBytes(Buffer.from([0x1f, 0x8b, 0x08, 0x00]).toString('base64'));
  check('base64ToBytes round-trips bytes (envelope primitive)', magic[0] === 0x1f && magic[1] === 0x8b, `[${magic[0]},${magic[1]}]`);

  // ---- shared pprofFromResponse reuse: all three adapters use parsePprofBytes ----
  console.log('\ncross-adapter sanity:');
  // Verify all three returned profiles have the same structure (same pprof fixture behind mock)
  check('debug and pyro profiles have matching weightType count',
    debugProfile.capabilities.weightTypes.length === pyroProfile.capabilities.weightTypes.length,
    `debug=${debugProfile.capabilities.weightTypes.length} pyro=${pyroProfile.capabilities.weightTypes.length}`);
  check('debug and parca profiles have matching weightType count',
    debugProfile.capabilities.weightTypes.length === parcaProfile.capabilities.weightTypes.length,
    `debug=${debugProfile.capabilities.weightTypes.length} parca=${parcaProfile.capabilities.weightTypes.length}`);
  check('all adapter ids are distinct',
    new Set([debugPprofAdapter.id, pyroscopeAdapter.id, parcaAdapter.id]).size === 3);

  // ---- interface shape: all three adapters conform ----
  for (const [name, adapter] of [
    ['debugPprofAdapter', debugPprofAdapter],
    ['pyroscopeAdapter',  pyroscopeAdapter],
    ['parcaAdapter',      parcaAdapter],
  ] as const) {
    check(`${name} has id`,           typeof adapter.id === 'string' && adapter.id.length > 0);
    check(`${name} has label`,        typeof adapter.label === 'string' && adapter.label.length > 0);
    check(`${name} has fetchProfile`, typeof adapter.fetchProfile === 'function');
    check(`${name} has describe`,     typeof adapter.describe === 'function');
  }

} finally {
  srv.close();
}

const total = pass + fail;
console.log(`\nadapters: ${pass}/${total} checks passed${fail > 0 ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail === 0 ? 0 : 1);
