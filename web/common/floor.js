// Tracks the floor height as the scan goes, so hits are classified by height *above the floor*
// rather than absolute y. local-floor's y=0 can be off, and the estimate drifts or floors slope
// (first real scan: floor rose 0.23 m over an 11 m aisle).
//
// Chrome's hit test only hits ARCore planes, so every hit on the floor has exactly the same y.
// The floor is therefore the biggest flat cluster of hits below the phone. Early in a session
// ARCore can briefly report phantom planes (third scan: -0.44 and -0.32 before settling at
// -0.15), so a new height that persists for RELOCK_FRAMES replaces the estimate outright.

const ALPHA = 0.15; // EMA weight per frame
const MAX_JUMP = 0.15; // m; a cluster further than this from the estimate is a candidate re-lock
const RELOCK_FRAMES = 10; // ~1 s of a consistent new height
const MIN_BELOW_PHONE = 0.1; // floor hits must be at least this far below the phone
const MIN_CLUSTER = 3; // hits needed to call something the floor
const CLUSTER_SPAN = 0.05; // m; how flat that cluster must be

// Biggest group of ys within CLUSTER_SPAN of each other (ties go to the lower one). ys sorted.
function biggestCluster(ys) {
  let best = null;
  for (let i = 0, j = 0; i < ys.length; i++) {
    if (j < i) j = i;
    while (j + 1 < ys.length && ys[j + 1] - ys[i] <= CLUSTER_SPAN) j++;
    const n = j - i + 1;
    if (n >= MIN_CLUSTER && (!best || n > best.n)) best = { n, y: ys[(i + j) >> 1] };
  }
  return best;
}

export class FloorTracker {
  constructor(initial = 0) {
    this.y = initial;
    this.seen = false;
    this.pending = null; // { y, n } candidate re-lock height
  }

  // Feed one frame: phone y + hit points. Returns the floor estimate after the update.
  update(phoneY, pts) {
    const ys = pts
      .map((h) => h[1])
      .filter((y) => y < phoneY - MIN_BELOW_PHONE)
      .sort((a, b) => a - b);
    const c = biggestCluster(ys);
    if (!c) return this.y;

    if (!this.seen) {
      this.y = c.y;
      this.seen = true;
    } else if (Math.abs(c.y - this.y) <= MAX_JUMP) {
      this.y += ALPHA * (c.y - this.y);
      this.pending = null;
    } else if (this.pending && Math.abs(c.y - this.pending.y) <= CLUSTER_SPAN) {
      if (++this.pending.n >= RELOCK_FRAMES) {
        this.y = c.y;
        this.pending = null;
      }
    } else {
      this.pending = { y: c.y, n: 1 };
    }
    return this.y;
  }
}
