// FG-025 (pass 1) — metric fixture helpers.
// Synthesizes 1-2 MetricSeries aligned to the chart time domain of a timed profile,
// with no external dependencies. Used by browser.ts to drive the track-lanes feature.

/**
 * Build a pair of synthetic MetricSeries for a profile that carries timing.
 * - series 0: a CPU% sine wave over [start, end]
 * - series 1: a RAM ramp over [start, end]
 * Both have `n` samples evenly spaced across the full time range.
 *
 * @param start - chart.start (domain units)
 * @param end   - chart.end   (domain units)
 * @param n     - number of sample points (default 64)
 */
export function syntheticMetrics(start: number, end: number, n = 64) {
  const time: number[] = [];
  const cpuValue: number[] = [];
  const ramValue: number[] = [];
  const span = end - start || 1;
  for (let i = 0; i < n; i++) {
    const t = start + (i / (n - 1)) * span;
    time.push(t);
    cpuValue.push(40 + 35 * Math.sin((i / (n - 1)) * 2 * Math.PI));  // 5..75 %
    ramValue.push(200 + (i / (n - 1)) * 600);                          // 200..800 MB
  }
  return [
    { name: 'CPU', unit: '%', time: [...time], value: cpuValue },
    { name: 'RAM', unit: 'MB', time: [...time], value: ramValue },
  ];
}
