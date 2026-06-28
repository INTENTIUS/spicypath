// Node file wrapper. Pure core: parse-speedscope.js (handles sampled + evented)
import { readFileSync } from 'node:fs';
import { parseSpeedscopeText } from '../src/parse-speedscope.js';
import type { Profile } from '../src/model.ts';
export function parseSpeedscope(path: string): Profile { return parseSpeedscopeText(readFileSync(path, 'utf8')) as Profile; }
