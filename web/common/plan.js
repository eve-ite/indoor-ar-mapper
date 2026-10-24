// Floor plan: split obstacles into structure (walls, pillars, counters) and furniture (tables,
// chairs, bags) so a map can be drawn like a standard floor plan: walls only.
// Display-only: routing still avoids furniture (see trav.js).

export const PLAN_DEFAULTS = {
  wallMinTop: 1.0, // m: anything seen this high is structure (tables/chairs are ~0.45-0.8 m)
  longRun: 2.0, // m: or a long, thin run (a wall seen only low down, e.g. from car height)
  maxFill: 0.35, // ...whose bounding box is mostly empty (thin), unlike a table top
};

// occ: obstacle mask (trav.occ). Returns Uint8Array: 1 = structure, 0 = furniture/none.
export function wallMask(grid, occ, opts = {}) {
  const o = { ...PLAN_DEFAULTS, ...opts };
  const { w, h, cell, obsTop } = grid;
  const out = new Uint8Array(w * h);
  const seen = new Uint8Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!occ[start] || seen[start]) continue;
    // 8-connected component of obstacle cells
    const comp = [start];
    seen[start] = 1;
    let top = 0, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < comp.length; k++) {
      const i = comp[k], x = i % w, z = (i / w) | 0;
      top = Math.max(top, obsTop[i] || 0);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, nz = z + dz, n = nz * w + nx;
          if (nx >= 0 && nz >= 0 && nx < w && nz < h && occ[n] && !seen[n]) {
            seen[n] = 1;
            comp.push(n);
          }
        }
      }
    }
    const bw = x1 - x0 + 1, bh = z1 - z0 + 1;
    const long = Math.max(bw, bh) * cell;
    const fill = comp.length / (bw * bh);
    // A component's tall cells make it structure, but only judge height on a robust top: use the
    // 90th percentile so one noisy depth sample doesn't promote a table.
    const tops = comp.map((i) => obsTop[i] || 0).sort((a, b) => a - b);
    const robustTop = tops[Math.floor(tops.length * 0.9)] ?? top;
    const isWall = robustTop >= o.wallMinTop || (long >= o.longRun && fill <= o.maxFill);
    if (isWall) for (const i of comp) out[i] = 1;
  }
  return out;
}
