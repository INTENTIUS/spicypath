// Canonical model TYPES (spec: docs/flamegraphs/data-model.md). Runtime is in model.js
// so the browser can use it without a build step.

export type ValueType = string; // 'samples' | 'cpu_nanos' | 'wall_nanos' | 'alloc_bytes' | ...

export interface FuncTable { name: number[]; file: number[]; line: number[]; }
export interface FrameTable { func: number[]; line: number[]; inlineDepth: number[]; }
export interface StackTable { frame: number[]; prefix: number[]; }
export interface Samples { stack: number[]; weightsByType: Record<string, number[]>; time: number[] | null; }
export interface Thread { name: string; samples: Samples; }
export interface MetricSeries { name: string; unit: string; time: number[]; value: number[]; }
export interface Capabilities { hasTiming: boolean; weightTypes: ValueType[]; isDiff: boolean; }
export interface Profile {
  stringTable: string[];
  funcTable: FuncTable;
  frameTable: FrameTable;
  stackTable: StackTable;
  threads: Thread[];
  metrics: MetricSeries[];
  capabilities: Capabilities;
}
