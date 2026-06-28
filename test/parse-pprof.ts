// Node file wrapper. Pure core: parse-pprof.js (gunzips here; core takes raw bytes)
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parsePprofBytes } from '../src/parse-pprof.js';
import type { Profile } from '../src/model.ts';
export function parsePprof(path: string): Profile {
  const raw = readFileSync(path);
  const data = (raw[0] === 0x1f && raw[1] === 0x8b) ? gunzipSync(raw) : raw;
  return parsePprofBytes(data) as Profile;
}
