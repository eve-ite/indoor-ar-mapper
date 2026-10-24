// 2D log-odds occupancy grid on the X/Z plane (WebXR local-floor, Y up).
import { FloorTracker } from './floor.js';

export const DEFAULTS = {
  cell: 0.05, // m; >= ARCore pose noise, <= half the smallest gap that matters
  floorMax: 0.1, // hits less than this above the tracked floor are floor -> free
  wallMin: 0.2, // hits in [wallMin, wallMax] above the floor are walls/obstacles -> occupied
  wallMax: 2.0,
  maxRange: 6.0, // ignore hits farther than this from the phone (m, in X/Z)
  clearBelow: 0.5, // a ray only fully clears a cell where it passes below this height (tables, chairs)
  overheadFree: 0, // free weight where the ray passes above clearBelow: it proves nothing about what is under it
  lFree: -0.4,
  lOcc: 0.85,
  lClamp: 5,
  pad: 0.5, // m around the data bounds
  bodyRadius: 0.25, // m; half the width of whatever walked/drove the scan
  maxStep: 1.0, // m; trajectory jumps longer than this (tracking glitches) aren't stamped as walked
  depthMargin: 0.04, // m; extra height tolerance for depth samples (noisier than plane hits)...
  depthMarginPerM: 0.02, // ...plus this much per meter of range, since depth noise grows with distance
};

// Who scanned / who will travel. Heights are above the tracked floor.
export const PROFILES = {
  person: { label: 'Person', floorMax: 0.1, wallMin: 0.2, wallMax: 2.0, clearBelow: 0.5, bodyRadius: 0.25 },
  car: { label: 'RC car', floorMax: 0.05, wallMin: 0.07, wallMax: 0.45, clearBelow: 0.45, bodyRadius: 0.15 },
};

const CAR_MAX_PHONE_HEIGHT = 0.7; // m; a phone riding lower than this is on the car

// Guess the profile from how high the phone rode above the tracked floor.
export function detectProfile(frames) {
  const floors = floorPerFrame(frames);
  const hs = frames.map((f, i) => f.p[1] - floors[i]).sort((a, b) => a - b);
  const median = hs[hs.length >> 1] ?? 1;
  return { profile: median < CAR_MAX_PHONE_HEIGHT ? 'car' : 'person', phoneHeight: median };
}

const MAX_CELLS_PER_SIDE = 4000;

export function buildGrid(frames, opts = {}) {
  const o = { ...DEFAULTS, ...opts };

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const grow = (x, z) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };
  for (const f of frames) {
    grow(f.p[0], f.p[2]);
    for (const h of allHits(f)) {
      if (Math.hypot(h[0] - f.p[0], h[2] - f.p[2]) <= o.maxRange) grow(h[0], h[2]);
    }
  }
  if (!isFinite(minX)) return null;
  minX -= o.pad; minZ -= o.pad; maxX += o.pad; maxZ += o.pad;

  const w = Math.min(MAX_CELLS_PER_SIDE, Math.ceil((maxX - minX) / o.cell) + 1);
  const h = Math.min(MAX_CELLS_PER_SIDE, Math.ceil((maxZ - minZ) / o.cell) + 1);
  const L = new Float32Array(w * h);

  const toCell = (x, z) => [Math.floor((x - minX) / o.cell), Math.floor((z - minZ) / o.cell)];
  const inside = (cx, cz) => cx >= 0 && cz >= 0 && cx < w && cz < h;
  const bump = (cx, cz, dl) => {
    if (!inside(cx, cz)) return;
    const i = cz * w + cx;
    L[i] = Math.max(-o.lClamp, Math.min(o.lClamp, L[i] + dl));
  };

  // Bresenham from (x0,z0) to (x1,z1): every cell before the endpoint is free.
  // A ray passing high over a cell doesn't prove there's no table under it, so it only counts weakly.
  const traceFree = (x0, z0, y0, x1, z1, y1) => {
    let dx = Math.abs(x1 - x0), dz = -Math.abs(z1 - z0);
    const sx = x0 < x1 ? 1 : -1, sz = z0 < z1 ? 1 : -1;
    const steps = Math.max(dx, -dz) || 1;
    let err = dx + dz;
    for (let k = 0; !(x0 === x1 && z0 === z1); k++) {
      const y = y0 + ((y1 - y0) * k) / steps;
      bump(x0, z0, y <= o.clearBelow ? o.lFree : o.lFree * o.overheadFree);
      const e2 = 2 * err;
      if (e2 >= dz) { err += dz; x0 += sx; }
      if (e2 <= dx) { err += dx; z0 += sz; }
    }
  };

  // All heights below are relative to the tracked floor, not local-floor's y=0.
  const floors = floorPerFrame(frames);
  // obs counts obstacle hits per cell on their own, so floor seen *under* a table can't vote the
  // table away (trav.js decides from it).
  const obs = new Uint16Array(w * h);
  const counts = { floor: 0, wall: 0, ignored: 0 };
  frames.forEach((f, i) => {
    const floor = floors[i];
    const phoneH = f.p[1] - floor;
    const [px, pz] = toCell(f.p[0], f.p[2]);
    bump(px, pz, o.lFree); // the phone/car was physically here
    for (const [hits, isDepth] of [[f.pts, false], [f.dpts, true]]) {
      for (const hit of hits || []) {
        const [hx, hy, hz] = hit;
        const hitH = hy - floor;
        if (Math.hypot(hx - f.p[0], hz - f.p[2]) > o.maxRange) { counts.ignored++; continue; }
        const [cx, cz] = toCell(hx, hz);
        const cls = classifyHeight(hitH, o, hitMargin(f, hit, isDepth, o));
        if (cls === 'floor') {
          traceFree(px, pz, phoneH, cx, cz, hitH);
          bump(cx, cz, o.lFree);
          counts.floor++;
        } else if (cls === 'wall') {
          traceFree(px, pz, phoneH, cx, cz, hitH);
          bump(cx, cz, o.lOcc);
          if (inside(cx, cz)) obs[cz * w + cx] = Math.min(65535, obs[cz * w + cx] + 1);
          counts.wall++;
        } else {
          counts.ignored++; // ceiling / between floor and wall band
        }
      }
    }
  });

  // Walked corridor: a body of bodyRadius physically passed along the trajectory, so those
  // cells are proven passable no matter what the hits say.
  const walked = new Uint8Array(w * h);
  const r = Math.max(0, Math.round(o.bodyRadius / o.cell));
  const disk = [];
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r) disk.push([dx, dz]);
  const stamp = (x, z) => {
    const [cx, cz] = toCell(x, z);
    for (const [dx, dz] of disk) if (inside(cx + dx, cz + dz)) walked[(cz + dz) * w + cx + dx] = 1;
  };
  for (let i = 1; i < frames.length; i++) {
    const [ax, , az] = frames[i - 1].p;
    const [bx, , bz] = frames[i].p;
    const len = Math.hypot(bx - ax, bz - az);
    if (len > o.maxStep) continue;
    const n = Math.max(1, Math.ceil(len / (o.cell / 2)));
    for (let k = 0; k <= n; k++) stamp(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n);
  }
  if (frames.length === 1) stamp(frames[0].p[0], frames[0].p[2]);

  return { w, h, minX, minZ, cell: o.cell, L, obs, walked, counts, floors, opts: o };
}

export function floorPerFrame(frames) {
  const tracker = new FloorTracker();
  return frames.map((f) => tracker.update(f.p[1], f.pts || []));
}

// y is height above the tracked floor. margin widens the floor band and raises the obstacle
// floor for noisy sources (depth samples), so floor noise doesn't read as low obstacles.
export function classifyHeight(y, o, margin = 0) {
  if (y < o.floorMax + margin) return 'floor';
  if (y >= o.wallMin + margin && y <= o.wallMax) return 'wall';
  return 'other';
}

// Height tolerance for one hit: plane hits are exact; depth gets noisier with range.
export function hitMargin(f, hit, isDepth, o) {
  if (!isDepth) return 0;
  const d = Math.hypot(hit[0] - f.p[0], hit[1] - f.p[1], hit[2] - f.p[2]);
  return o.depthMargin + o.depthMarginPerM * d;
}

// Plane hit-test hits (pts) + depth-map samples (dpts, when the scan had depth).
export function allHits(f) {
  return f.dpts ? [...(f.pts || []), ...f.dpts] : f.pts || [];
}
