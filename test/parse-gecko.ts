// Node file wrapper. Pure core: parse-gecko.js
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseGeckoText } from '../src/parse-gecko.js';
import type { Profile } from '../src/model.ts';
export function parseGecko(path: string): Profile {
  const raw = readFileSync(path);
  const data = (raw[0] === 0x1f && raw[1] === 0x8b) ? gunzipSync(raw) : raw;
  return parseGeckoText(data.toString('utf8')) as Profile;
}
