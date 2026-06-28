// Node file wrapper. Pure core: parse-cpuprofile.js
import { readFileSync } from 'node:fs';
import { parseCpuProfileText } from '../src/parse-cpuprofile.js';
import type { Profile } from '../src/model.ts';
export function parseCpuProfile(path: string): Profile { return parseCpuProfileText(readFileSync(path, 'utf8')) as Profile; }
