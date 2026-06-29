// Deterministic CPU + allocation workload for generating a real JFR recording at test time.
// FG-031 (CPU): fib() dominates ExecutionSample so the parser output can be asserted against
//   the `jfr print` oracle (fib is the overwhelmingly hot leaf).
// FG-052 (alloc): allocHot() allocates byte arrays in a tight loop so jdk.ObjectAllocationSample
//   (and jdk.ObjectAllocationInNewTLAB / jdk.ObjectAllocationOutsideTLAB) are emitted under
//   settings=profile, giving the alloc_bytes dimension an identifiable hot allocator.
// FG-053 (threads): 3 worker threads run fib+allocHot in parallel so the recording has
//   multiple real threads — exercising the per-thread split, merged "all threads" view, and
//   the thread selector.
// NOT committed as a .jfr — the recording is generated into test/out/ (gitignored) by
//   test/parse-jfr-test.ts when a JDK is present, and skipped otherwise.
public class JfrWorkload {
  static volatile long sink;
  static volatile Object objSink;

  // --- CPU hot path (FG-031) ---
  static long fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
  static void hot()  { for (int i = 0; i < 40; i++) sink += fib(32); }
  static void warm() { for (int i = 0; i < 8;  i++) sink += fib(30); }

  // --- Allocation hot path (FG-052) ---
  // Allocates byte arrays of varying sizes to trigger both TLAB and outside-TLAB paths.
  // The method name "allocHot" is asserted by the test as the hot allocator.
  static void allocHot() {
    for (int i = 0; i < 2000; i++) {
      // Small allocations (typically in TLAB) — jdk.ObjectAllocationInNewTLAB or Sample
      byte[] small = new byte[256 + (i & 0xff)];
      sink += small.length;
      // Medium allocations — more likely to be sampled
      byte[] med = new byte[8192 + (i & 0xfff)];
      sink += med.length;
      objSink = med; // keep alive briefly to avoid over-eager elimination
    }
  }

  // --- Worker thread: runs fib+allocHot until the deadline ---
  static class Worker implements Runnable {
    final long endMs;
    Worker(long endMs) { this.endMs = endMs; }
    public void run() {
      while (System.currentTimeMillis() < endMs) {
        hot();
        warm();
        allocHot();
      }
    }
  }

  public static void main(String[] a) throws Exception {
    final long end = System.currentTimeMillis() + 2500;

    // FG-053: spawn 2 worker threads (in addition to main) so the recording has ≥3 real threads.
    Thread w1 = new Thread(new Worker(end), "worker-1");
    Thread w2 = new Thread(new Worker(end), "worker-2");
    w1.start();
    w2.start();

    // Main thread also does work
    while (System.currentTimeMillis() < end) {
      hot();
      warm();
      allocHot();
    }

    w1.join();
    w2.join();
  }
}
