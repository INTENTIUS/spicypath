// Workload to produce a REAL V8 .cpuprofile (timed) via: node --cpu-prof
// Nested calls so the profile has interesting, multi-level stacks.
function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

function hashStrings() {
  let s = 0;
  for (let i = 0; i < 200000; i++) s += ('x' + i).length * Math.sqrt(i);
  return s;
}

function jsonWork() {
  const o = {};
  for (let i = 0; i < 40000; i++) o['k' + i] = i;
  return JSON.stringify(o).length;
}

function handleRequest() {
  let t = 0;
  t += fib(30);
  t += hashStrings();
  t += jsonWork();
  return t;
}

const end = Date.now() + 500;
let acc = 0;
while (Date.now() < end) acc += handleRequest();
console.error('node workload done', acc);
