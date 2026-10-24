// Tracks the floor height as the scan goes, so hits are classified by height *above the floor*
// rather than absolute y. local-floor's y=0 can be off, and the estimate drifts or floors slope
// (first real scan: floor rose 0.23 m over an 11 m aisle).

const ALPHA = 0.15; // EMA weight per frame
const MAX_JUMP = 0.15; // m; a lower hit further than this from the estimate isn't the floor
const MIN_BELOW_PHONE = 0.1; // floor hits must be at least this far below the phone
const MIN_CLUSTER = 3; // hits needed to call something the floor
const CLUSTER_SPAN = 0.05; // m; how flat that cluster must be

export class FloorTracker {
  constructor(initial = 0) {
    this.y = initial;
    this.seen = false;
  }

  // Feed one frame: phone y + hit points. Returns the floor estimate after the update.
  // The floor is the lowest tight cluster of hits: floor hits share one height, while hits on
  // the bottom of a wall are spread out, so a frame without real floor hits can't drag it up.
  update(phoneY, pts) {
    const ys = pts
      .map((h) => h[1])
      .filter((y) => y < phoneY - MIN_BELOW_PHONE && (!this.seen || Math.abs(y - this.y) <= MAX_JUMP))
      .sort((a, b) => a - b);
    for (let i = 0; i + MIN_CLUSTER <= ys.length; i++) {
      let j = i;
      while (j + 1 < ys.length && ys[j + 1] - ys[i] <= CLUSTER_SPAN) j++;
      if (j - i + 1 >= MIN_CLUSTER) {
        const median = ys[(i + j) >> 1];
        this.y = this.seen ? this.y + ALPHA * (median - this.y) : median;
        this.seen = true;
        break;
      }
    }
    return this.y;
  }
}
