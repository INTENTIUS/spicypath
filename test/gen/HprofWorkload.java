// FG-057/FG-058/FG-059 — deterministic heap-dump generator for the HPROF test.
//
// Builds an object graph whose dominator relationships and retained sizes are KNOWN by
// construction, then writes a real `.hprof` via HotSpotDiagnosticMXBean.dumpHeap(path, live=true).
// This is the ground-truth oracle for the heap-analysis family: the parser (FG-058) and the
// dominator/retained-size computation (FG-059) are asserted against these known facts, the way
// JfrWorkload.java + the `jfr print` oracle pin the sampled-profile parser.
//
// NOT committed as a .hprof — the dump is generated into test/out/ (gitignored) by
// test/parse-hprof-test.ts when a JDK is present, and skipped otherwise.
//
// The graph (root is the static field ROOT — a GC root):
//
//   ROOT ─┬─ excl:  ExclusiveOwner ── byte[EXCL]              (exclusively owned)
//         ├─ a:     SharerA ─┐
//         │                  ├─ shared: SharedPayload ── byte[SHARED]   (SHARED ownership)
//         ├─ b:     SharerB ─┘
//         ├─ chain: ChainLink(C1) ── ChainLink(C2) ── ChainLink(C3)     (linear chain)
//         └─ cycle: CycleNode x ⇄ CycleNode y   (each owns byte[CYCLE]) (a reference cycle)
//
//   + one byte[GARBAGE] that is dropped and GC'd before the dump (must be ABSENT from a live dump).
//
// Ground truth this encodes (checked by the test):
//   • EXCLUSIVE: byte[EXCL] is dominated solely by ExclusiveOwner → its retained size ≈ EXCL.
//   • SHARED:    byte[SHARED] is referenced by BOTH SharerA and SharerB, so it is dominated by
//                their common dominator (Root), NOT by either sharer. A correct dominator
//                computation must NOT attribute SHARED to SharerA or SharerB (no double-count);
//                a naive "sum of everything reachable" would. This is the decisive test.
//   • CYCLE:     x ⇄ y. x is reachable directly (ROOT.cycle=x); y only via x.peer → idom(y)=x.
//                The computation must TERMINATE and give retained(x) ⊇ {x, y, both arrays},
//                retained(y) ⊇ {y, its own array} only.
//   • CHAIN:     retained(C1) > retained(C2) > retained(C3), each ≥ its own array (monotone).
//   • GARBAGE:   byte[GARBAGE] must not appear (live=true dump excludes unreachable objects).
//
// Sizes are distinct and prime-ish so each payload array is uniquely identifiable in the dump
// and its retained contribution is unambiguous. Header/overhead is small vs these sizes, so the
// test asserts retained size within a tolerance band, and the structural facts (who dominates
// whom, shared-not-double-counted) exactly.
public class HprofWorkload {
  static final int EXCL    = 4_000_037; // exclusively owned by ExclusiveOwner
  static final int SHARED  = 2_000_003; // referenced by BOTH SharerA and SharerB
  static final int CYCLE   = 1_000_003; // each cycle node owns one
  static final int C1SZ    =   300_017; // chain link 1
  static final int C2SZ    =   200_003; // chain link 2
  static final int C3SZ    =   100_003; // chain link 3
  static final int GARBAGE = 5_000_011; // dropped before the dump — must be absent from a live dump

  // A single static field pins the whole graph alive (a GC root of kind "sticky class"/static).
  static Root ROOT;

  static final class Root {
    ExclusiveOwner excl;
    SharerA a;
    SharerB b;
    ChainLink chain;
    CycleNode cycle;
  }
  static final class ExclusiveOwner { byte[] payload = new byte[EXCL]; }
  static final class SharedPayload  { byte[] payload; SharedPayload(int n) { payload = new byte[n]; } }
  static final class SharerA { SharedPayload shared; }
  static final class SharerB { SharedPayload shared; }
  static final class ChainLink { byte[] payload; ChainLink next; ChainLink(int n) { payload = new byte[n]; } }
  static final class CycleNode { byte[] payload = new byte[CYCLE]; CycleNode peer; }

  // Build the graph in its OWN frame so that, once it returns, no local variable references any
  // of these objects — the graph is then reachable ONLY through the static field ROOT (a single
  // GC root). If we built it inline in main(), the live locals (r, shared, x, y, …) would each be
  // a thread-frame GC root at dump time, flattening the dominator tree (every object a root).
  static void build() {
    Root r = new Root();

    // Exclusive ownership.
    r.excl = new ExclusiveOwner();

    // Shared ownership — the SAME SharedPayload instance under both sharers.
    SharedPayload shared = new SharedPayload(SHARED);
    r.a = new SharerA(); r.a.shared = shared;
    r.b = new SharerB(); r.b.shared = shared;

    // Linear chain C1 → C2 → C3.
    ChainLink c1 = new ChainLink(C1SZ);
    c1.next = new ChainLink(C2SZ);
    c1.next.next = new ChainLink(C3SZ);
    r.chain = c1;

    // Reference cycle x ⇄ y; x is the entry (reachable via ROOT.cycle).
    CycleNode x = new CycleNode();
    CycleNode y = new CycleNode();
    x.peer = y; y.peer = x;
    r.cycle = x;

    ROOT = r; // publish as a GC root (static field)
  }

  public static void main(String[] args) throws Exception {
    build(); // its frame (and all local refs) is gone before we dump

    // Unreachable garbage: touch it so it can't be scalarized away, then drop + GC.
    byte[] garbage = new byte[GARBAGE];
    garbage[0] = 1; garbage[GARBAGE - 1] = 2;
    garbage = null;
    System.gc();

    // dumpHeap refuses to overwrite an existing file — the test deletes it first.
    String out = args.length > 0 ? args[0] : "heap-workload.hprof";
    com.sun.management.HotSpotDiagnosticMXBean bean =
        java.lang.management.ManagementFactory.getPlatformMXBean(com.sun.management.HotSpotDiagnosticMXBean.class);
    bean.dumpHeap(out, true); // live=true → reachable objects only

    // Keep ROOT reachable until after the dump (no dead-store elimination).
    System.out.println("dumped " + out + " root=" + (ROOT != null));
  }
}
