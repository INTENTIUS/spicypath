// Deterministic CPU workload for generating a real JFR recording at test time (FG-031).
// Known hot path: fib() dominates, so the parser's output can be asserted against the
// `jfr print` oracle (fib is the overwhelmingly hot leaf). NOT committed as a .jfr — the
// recording is generated into test/out/ (gitignored) by test/parse-jfr-test.ts when a JDK
// is present, and skipped otherwise.
public class JfrWorkload {
  static volatile long sink;
  static long fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
  static void hot()  { for (int i = 0; i < 40; i++) sink += fib(32); }
  static void warm() { for (int i = 0; i < 8;  i++) sink += fib(30); }
  public static void main(String[] a) {
    final long end = System.currentTimeMillis() + 2500;
    while (System.currentTimeMillis() < end) { hot(); warm(); }
  }
}
