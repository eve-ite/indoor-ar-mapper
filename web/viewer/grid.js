// 2D log-odds occupancy grid on the X/Z plane (WebXR local-floor, Y up).
import { FloorTracker } from '../common/floor.js';

export const DEFAULTS = {
  cell: 0.05, // m; >= ARCore pose noise, <= half the smallest gap that matters
  floorMax: 0.1, // hits less than this above the tracked floor are floor -> free
  wallMin: 0.2, // hits in [wallMin, wallMax] above the floor are walls/obstacles -> occupied
  wallMax: 2.0,
  maxRange: 6.0, // ignore hits farther than this from the phone (m, in X/Z)
  clearBelow: 0.5, // a ray only fully clears a cell where it passes below this height (tables, chairs)
  overheadFree: 0.2, // free-update weight where the ray passes above clearBelow
  lFree: -0.4,
  lOcc: 0.85,
  lClamp: 5,
  pad: 0.5, // m around the data bounds
};

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
    for (const h of f.pts || []) {
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
  const counts = { floor: 0, wall: 0, ignored: 0 };
  frames.forEach((f, i) => {
    const floor = floors[i];
    const phoneH = f.p[1] - floor;
    const [px, pz] = toCell(f.p[0], f.p[2]);
    bump(px, pz, o.lFree); // the phone/car was physically here
    for (const hit of f.pts || []) {
      const [hx, hy, hz] = hit;
      const hitH = hy - floor;
      if (Math.hypot(hx - f.p[0], hz - f.p[2]) > o.maxRange) { counts.ignored++; continue; }
      const [cx, cz] = toCell(hx, hz);
      const cls = classifyHeight(hitH, o);
      if (cls === 'floor') {
        traceFree(px, pz, phoneH, cx, cz, hitH);
        bump(cx, cz, o.lFree);
        counts.floor++;
      } else if (cls === 'wall') {
        traceFree(px, pz, phoneH, cx, cz, hitH);
        bump(cx, cz, o.lOcc);
        counts.wall++;
      } else {
        counts.ignored++; // ceiling / between floor and wall band
      }
    }
  });

  return { w, h, minX, minZ, cell: o.cell, L, counts, floors, opts: o };
}

export function floorPerFrame(frames) {
  const tracker = new FloorTracker();
  return frames.map((f) => tracker.update(f.p[1], f.pts || []));
}

// y is height above the tracked floor.
export function classifyHeight(y, o) {
  if (y < o.floorMax) return 'floor';
  if (y >= o.wallMin && y <= o.wallMax) return 'wall';
  return 'other';
}
