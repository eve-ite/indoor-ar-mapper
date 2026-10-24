// Traversability on top of the occupancy grid, plus A*. Shared by the viewer and (later) the nav app.
//
// Three tiers, by trust:
//   walked     proven passable (someone/the car physically went there)  -> cheapest, never vetoed
//   floor seen floor-plane hits / free rays, probably passable           -> allowed, costs more
//   obstacle   occupied cells, inflated by the traveller's radius        -> blocked (unless walked)
// Unknown cells are blocked: only route where we have evidence.

export const TRAV = { BLOCKED: 0, WALKED: 1, SEEN: 2 };

export const TRAV_DEFAULTS = {
  occL: 1.0, // log-odds above this = obstacle
  obsMin: 2, // obstacle hits in a 3x3 neighbourhood (15 cm) = obstacle
  freeL: -0.5, // log-odds below this = floor seen
  seenCost: 4, // per-cell cost of floor-seen cells relative to walked ones
};

function dilate(mask, w, h, r) {
  if (r <= 0) return mask;
  const out = new Uint8Array(w * h);
  const disk = [];
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r) disk.push([dx, dz]);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      if (!mask[z * w + x]) continue;
      for (const [dx, dz] of disk) {
        const nx = x + dx, nz = z + dz;
        if (nx >= 0 && nz >= 0 && nx < w && nz < h) out[nz * w + nx] = 1;
      }
    }
  }
  return out;
}

// Returns { tier: Uint8Array of TRAV values, cost: Float32Array (Infinity = blocked), occ: obstacle mask }.
export function traversability(grid, opts = {}) {
  const o = { ...TRAV_DEFAULTS, ...opts };
  const { w, h, L, obs, walked } = grid;
  // Obstacle: enough obstacle hits in the 3x3 neighbourhood (depth hits are sparse per 5 cm cell),
  // regardless of floor seen in the same cells (floor under a table top).
  const occ = new Uint8Array(w * h);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, nz = z + dz;
          if (nx >= 0 && nz >= 0 && nx < w && nz < h) n += obs[nz * w + nx];
        }
      }
      if (n >= o.obsMin || L[z * w + x] > o.occL) occ[z * w + x] = 1;
    }
  }
  const blocked = dilate(occ, w, h, Math.round(grid.opts.bodyRadius / grid.cell));

  const tier = new Uint8Array(w * h);
  const cost = new Float32Array(w * h).fill(Infinity);
  for (let i = 0; i < tier.length; i++) {
    if (walked[i]) {
      tier[i] = TRAV.WALKED;
      cost[i] = 1;
    } else if (!blocked[i] && L[i] < o.freeL) {
      tier[i] = TRAV.SEEN;
      cost[i] = o.seenCost;
    }
  }
  return { tier, cost, occ };
}

// 8-connected A* over the cost grid. start/goal are cell indices.
// Returns the path as cell indices (start..goal), or null.
export function astar(cost, w, h, start, goal) {
  if (!isFinite(cost[start]) || !isFinite(cost[goal])) return null;
  const g = new Float32Array(w * h).fill(Infinity);
  const came = new Int32Array(w * h).fill(-1);
  const closed = new Uint8Array(w * h);
  const gx = goal % w, gz = (goal / w) | 0;
  const heur = (i) => {
    const dx = Math.abs((i % w) - gx), dz = Math.abs(((i / w) | 0) - gz);
    return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz); // octile, min cost 1
  };
  const heap = new MinHeap();
  g[start] = 0;
  heap.push(heur(start), start);
  const steps = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

  while (heap.size) {
    const cur = heap.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % w, cz = (cur / w) | 0;
    for (const [dx, dz, len] of steps) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
      const n = nz * w + nx;
      if (closed[n] || !isFinite(cost[n])) continue;
      // No corner cutting: diagonal moves need both side cells open.
      if (dx && dz && (!isFinite(cost[cz * w + nx]) || !isFinite(cost[nz * w + cx]))) continue;
      const ng = g[cur] + len * (cost[cur] + cost[n]) / 2;
      if (ng < g[n]) {
        g[n] = ng;
        came[n] = cur;
        heap.push(ng + heur(n), n);
      }
    }
  }
  if (start !== goal && came[goal] < 0) return null;
  const path = [goal];
  while (path[path.length - 1] !== start) path.push(came[path[path.length - 1]]);
  return path.reverse();
}

// String-pull an A* cell path: keep a straight segment while every cell on it is passable and no
// pricier than its endpoints (so a walked-only route stays on walked cells). Returns cell indices.
export function simplifyPath(path, cost, w) {
  if (!path || path.length < 3) return path;
  const clear = (a, b) => {
    const limit = Math.max(cost[a], cost[b]);
    let x0 = a % w, z0 = (a / w) | 0;
    const x1 = b % w, z1 = (b / w) | 0;
    const dx = Math.abs(x1 - x0), dz = -Math.abs(z1 - z0);
    const sx = x0 < x1 ? 1 : -1, sz = z0 < z1 ? 1 : -1;
    let err = dx + dz;
    for (;;) {
      if (!(cost[z0 * w + x0] <= limit)) return false;
      if (x0 === x1 && z0 === z1) return true;
      const e2 = 2 * err;
      if (e2 >= dz) { err += dz; x0 += sx; }
      if (e2 <= dx) { err += dx; z0 += sz; }
    }
  };
  const out = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let j = path.length - 1;
    while (j > i + 1 && !clear(path[i], path[j])) j--;
    out.push(path[j]);
    i = j;
  }
  return out;
}

class MinHeap {
  constructor() {
    this.k = [];
    this.v = [];
  }
  get size() {
    return this.k.length;
  }
  push(key, val) {
    const { k, v } = this;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop() {
    const { k, v } = this;
    const top = v[0];
    const lastK = k.pop(), lastV = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lastK;
        if (l < k.length && k[l] < mk) { m = l; mk = k[l]; }
        if (r < k.length && k[r] < mk) { m = r; mk = k[r]; }
        if (m === i) break;
        k[i] = k[m];
        v[i] = v[m];
        i = m;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return top;
  }
}
