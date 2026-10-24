// Scan chaining: a scan that "continues" another started where the previous one ended (on a floor
// mark, facing the same way). Each WebXR session has its own local-floor origin, so we bring every
// child into its parent's frame with a 2D rigid transform (x, z, yaw; gravity is shared), then
// optionally refine it by matching obstacles seen in both scans around the handover.
import { buildGrid, floorPerFrame } from './grid.js';

// Heading of the camera's forward (-Z) projected onto the floor, as a yaw about +Y.
// yaw 0 looks down -Z; forward = (-sin yaw, 0, -cos yaw).
export function yawOf([x, y, z, w]) {
  const fx = -2 * (x * z + w * y);
  const fz = -(1 - 2 * (x * x + y * y));
  return Math.atan2(-fx, -fz);
}

// 2D rigid transform { yaw, tx, tz }: rotate about +Y by yaw, then translate.
export function apply(T, x, z) {
  const c = Math.cos(T.yaw), s = Math.sin(T.yaw);
  // Rotation about +Y: x' = c*x + s*z, z' = -s*x + c*z
  return [c * x + s * z + T.tx, -s * x + c * z + T.tz];
}

export function compose(A, B) {
  // (A ∘ B)(p) = A(B(p))
  const [tx, tz] = apply({ yaw: A.yaw, tx: 0, tz: 0 }, B.tx, B.tz);
  return { yaw: A.yaw + B.yaw, tx: tx + A.tx, tz: tz + A.tz };
}

export const poseToT = (p, q) => ({ yaw: yawOf(q), tx: p[0], tz: p[2] });

export function invert(T) {
  const [tx, tz] = apply({ yaw: -T.yaw, tx: 0, tz: 0 }, -T.tx, -T.tz);
  return { yaw: -T.yaw, tx, tz };
}

// Child-local -> parent-local: the child's first pose is placed onto the parent's last pose.
export function linkTransform(parentEnd, childStart) {
  return compose(poseToT(parentEnd.p, parentEnd.q), invert(poseToT(childStart.p, childStart.q)));
}

// Quaternion of a yaw about +Y, and q1 * q2.
const qYaw = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
function qMul([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

const r3 = (v) => Math.round(v * 1000) / 1000;
const mapPt = (T, dy) => (h) => {
  const [x, z] = apply(T, h[0], h[2]);
  return [r3(x), r3(h[1] + dy), r3(z)];
};

// A frame/keyframe in child coordinates -> parent coordinates. dy shifts heights so the child's
// tracked floor lines up with the parent's (each session's local-floor y=0 is its own guess).
export function transformFrame(f, T, dy, dt) {
  const [x, z] = apply(T, f.p[0], f.p[2]);
  const out = { ...f, t: r3(f.t + dt), p: [r3(x), r3(f.p[1] + dy), r3(z)], q: qMul(qYaw(T.yaw), f.q) };
  if (f.pts) out.pts = f.pts.map(mapPt(T, dy));
  if (f.dpts) out.dpts = f.dpts.map(mapPt(T, dy));
  return out;
}

// ---- overlap refinement ----
const REFINE = {
  windowS: 10, // seconds at the start of the child to match against the parent
  minPoints: 30, // obstacle points needed on each side to trust a match
  maxShift: 0.5, // m search range around the mark-based placement
  shiftStep: 0.05,
  maxTurnDeg: 10,
  turnStepDeg: 1,
  cap: 0.25, // m: per-point distance cost is capped here (a point in open floor costs the cap)
  minKeptFrac: 0.6, // a candidate must keep this share of the unrefined placement's scored points
  regPerM: 0.05, // m of cost per m of shift: breaks ties toward the mark-based placement...
  regPerDeg: 0.002, // ...and per degree of turn
  minImprove: 0.01, // m: the refined cost must beat the unrefined one by this much
  obstacleMin: 0.2, // m above floor = obstacle
};

function obstaclePoints(frames, floors, fromT, toT) {
  const out = [];
  frames.forEach((f, i) => {
    if (f.t < fromT || f.t > toT) return;
    for (const h of [...(f.pts || []), ...(f.dpts || [])]) {
      if (h[1] - floors[i] >= REFINE.obstacleMin) out.push([h[0], h[2]]);
    }
  });
  return out;
}

// Distance (m) from every cell to the nearest obstacle cell: two-pass 3-4 chamfer transform.
function distanceField(mask, w, h, cell) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
  const relax = (i, j, c) => {
    if (d[j] + c < d[i]) d[i] = d[j] + c;
  };
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (x > 0) relax(i, i - 1, 3);
      if (z > 0) {
        relax(i, i - w, 3);
        if (x > 0) relax(i, i - w - 1, 4);
        if (x < w - 1) relax(i, i - w + 1, 4);
      }
    }
  }
  for (let z = h - 1; z >= 0; z--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = z * w + x;
      if (x < w - 1) relax(i, i + 1, 3);
      if (z < h - 1) {
        relax(i, i + w, 3);
        if (x < w - 1) relax(i, i + w + 1, 4);
        if (x > 0) relax(i, i + w - 1, 4);
      }
    }
  }
  for (let i = 0; i < d.length; i++) d[i] = (d[i] / 3) * cell;
  return d;
}

// Search small yaw/shift corrections (about the child's start position) that put the child's
// obstacle points on the parent's walls. Cost = mean capped distance to the nearest parent
// obstacle, over child points that land where the parent actually looked (near an obstacle, or on
// floor it saw as open); points in parent-unseen space are left out. Counting matches instead
// would reward sliding along a wall into the part the parent happened to see (aperture problem).
// Returns { T, used, cost, baseCost, correction? } with T the refined child->parent transform.
export function refineLink(parent, child, T0, opts = {}) {
  const o = { ...REFINE, ...opts };
  // Target = the parent's whole map (the child's opening view mostly re-sees earlier parts of the
  // parent, not just its last seconds); source = the child's first seconds.
  const pPts = obstaclePoints(parent.frames, parent.floors, -Infinity, Infinity);
  const cStart = child.frames[0].t;
  const cPts = obstaclePoints(child.frames, child.floors, cStart, cStart + o.windowS).map(([x, z]) => apply(T0, x, z));
  if (pPts.length < o.minPoints || cPts.length < o.minPoints) {
    return { T: T0, used: false, reason: `not enough obstacle points (${pPts.length}/${cPts.length})` };
  }
  const g = buildGrid(parent.frames);
  const dist = distanceField(Uint8Array.from(g.obs, (v) => (v > 0 ? 1 : 0)), g.w, g.h, g.cell);
  const cellOf = (x, z) => {
    const cx = Math.floor((x - g.minX) / g.cell), cz = Math.floor((z - g.minZ) / g.cell);
    return cx >= 0 && cz >= 0 && cx < g.w && cz < g.h ? cz * g.w + cx : -1;
  };
  const [px, pz] = apply(T0, child.frames[0].p[0], child.frames[0].p[2]);
  const evalAt = (yaw, sx, sz) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let inl = 0, sum = 0;
    for (const [x, z] of cPts) {
      const dx = x - px, dz = z - pz;
      const i = cellOf(c * dx + s * dz + px + sx, -s * dx + c * dz + pz + sz);
      if (i < 0) continue;
      if (dist[i] <= o.cap) sum += dist[i]; // near a parent wall
      else if (g.L[i] < -0.5) sum += o.cap; // parent saw open floor here: contradiction
      else continue; // parent never looked here: no evidence either way
      inl++;
    }
    return { inl, cost: inl ? sum / inl : Infinity };
  };
  const base = evalAt(0, 0, 0);
  if (base.inl < o.minPoints) {
    return { T: T0, used: false, reason: `too little overlap with the previous scan (${base.inl} matching points)` };
  }
  const reg = (yaw, sx, sz) => o.regPerM * Math.hypot(sx, sz) + o.regPerDeg * Math.abs((yaw * 180) / Math.PI);
  let best = { yaw: 0, sx: 0, sz: 0, cost: base.cost, total: base.cost };
  const turn = (o.maxTurnDeg * Math.PI) / 180, tStep = (o.turnStepDeg * Math.PI) / 180;
  for (let yaw = -turn; yaw <= turn + 1e-9; yaw += tStep) {
    for (let sx = -o.maxShift; sx <= o.maxShift + 1e-9; sx += o.shiftStep) {
      for (let sz = -o.maxShift; sz <= o.maxShift + 1e-9; sz += o.shiftStep) {
        const e = evalAt(yaw, sx, sz);
        if (e.inl < Math.max(o.minPoints, o.minKeptFrac * base.inl)) continue;
        const total = e.cost + reg(yaw, sx, sz);
        if (total < best.total) best = { yaw, sx, sz, cost: e.cost, total };
      }
    }
  }
  if (base.cost - best.total < o.minImprove) {
    return { T: T0, used: false, cost: base.cost, baseCost: base.cost, reason: 'no clearly better alignment' };
  }
  // Correction C = translate(px+sx, pz+sz) ∘ rotate(yaw) ∘ translate(-px, -pz); refined = C ∘ T0.
  const C = compose({ yaw: 0, tx: px + best.sx, tz: pz + best.sz }, compose({ yaw: best.yaw, tx: 0, tz: 0 }, { yaw: 0, tx: -px, tz: -pz }));
  return {
    T: compose(C, T0),
    used: true,
    cost: best.cost,
    baseCost: base.cost,
    correction: { yawDeg: Math.round((best.yaw * 180) / Math.PI * 10) / 10, dx: Math.round(best.sx * 100) / 100, dz: Math.round(best.sz * 100) / 100 },
  };
}

// Rotate by yawDeg about the handover point (px, pz), then shift by (dx, dz): a manual nudge.
export function nudgeAbout(px, pz, { yawDeg = 0, dx = 0, dz = 0 } = {}) {
  const yaw = (yawDeg * Math.PI) / 180;
  return compose({ yaw: 0, tx: px + dx, tz: pz + dz }, compose({ yaw, tx: 0, tz: 0 }, { yaw: 0, tx: -px, tz: -pz }));
}

// scans: parsed scans in chain order (root first), each { header, frames, keyframes? }.
// refine: try automatic overlap alignment (conservative; off by default).
// nudges: { [childSessionId]: { yawDeg, dx, dz } } manual corrections about each handover point.
// Returns { frames, keyframes, links: [{ id, T, refine, pivot }] } all in the root's coordinates.
export function mergeChain(scans, { refine = false, nudges = {} } = {}) {
  const root = scans[0];
  let frames = root.frames.slice();
  let keyframes = (root.keyframes || []).slice();
  let labels = (root.labels || []).map((l) => ({ ...l, scan: root.header?.session_id }));
  const links = [];
  let prev = { frames: root.frames, floors: floorPerFrame(root.frames), Tprev: { yaw: 0, tx: 0, tz: 0 }, dyPrev: 0 };
  let tEnd = frames.at(-1)?.t ?? 0;

  for (const scan of scans.slice(1)) {
    const floors = floorPerFrame(scan.frames);
    // Link in the previous scan's own coordinates, then chain onto the root.
    let T = linkTransform(prev.frames.at(-1), scan.frames[0]);
    let refineInfo = null;
    if (refine) {
      refineInfo = refineLink({ frames: prev.frames, floors: prev.floors }, { frames: scan.frames, floors }, T);
      T = refineInfo.T;
    }
    const id = scan.header?.session_id;
    // Handover point in the previous scan's coordinates (where this scan started).
    const pivot = apply(T, scan.frames[0].p[0], scan.frames[0].p[2]);
    if (nudges[id]) T = compose(nudgeAbout(pivot[0], pivot[1], nudges[id]), T);
    const Troot = compose(prev.Tprev, T);
    // Heights: line the child's floor up with the previous scan's floor at the handover.
    const dy = prev.dyPrev + (prev.floors.at(-1) - floors[0]);
    const dt = tEnd + 1 - scan.frames[0].t; // keep time increasing across the chain
    const moved = scan.frames.map((f) => transformFrame(f, Troot, dy, dt));
    frames = frames.concat(moved);
    keyframes = keyframes.concat((scan.keyframes || []).map((k) => ({ ...transformFrame(k, Troot, dy, dt), scan: id })));
    labels = labels.concat(
      (scan.labels || []).map((l) => {
        const [x, z] = apply(Troot, l.p[0], l.p[2]);
        return { ...l, t: r3(l.t + dt), p: [r3(x), r3(l.p[1] + dy), r3(z)], scan: id };
      }),
    );
    links.push({ id, T: Troot, refine: refineInfo, pivot: apply(prev.Tprev, pivot[0], pivot[1]) });
    prev = { frames: scan.frames, floors, Tprev: Troot, dyPrev: dy };
    tEnd = moved.at(-1)?.t ?? tEnd;
  }
  return { frames, keyframes, labels, links };
}

// Order a chain from server summaries: [{ id, continues }] -> ids root..leaf for the chain of `id`.
// Follows `continues` back to the root, then forward along the single child at each step.
export function chainOrder(summaries, id) {
  const byId = new Map(summaries.map((s) => [s.id, s]));
  let root = id;
  const seen = new Set();
  while (byId.get(root)?.continues && byId.has(byId.get(root).continues) && !seen.has(root)) {
    seen.add(root);
    root = byId.get(root).continues;
  }
  const order = [root];
  for (;;) {
    const kids = summaries.filter((s) => s.continues === order.at(-1)).sort((a, b) => (a.created < b.created ? -1 : 1));
    if (!kids.length || order.includes(kids[0].id)) break;
    order.push(kids[0].id); // branches: take the earliest continuation
  }
  return order;
}
