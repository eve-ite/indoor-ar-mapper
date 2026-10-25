// M5 navigation core (no DOM, no WebXR): start marks, lining a live session up with a map, routing
// and turn-by-turn. Shared by the AR page and the 2D fallback, and tested in node (tools/test_nav.mjs).
//
// Lining up works like scan chaining: the walker stands on a floor mark the map already knows,
// facing the way the scan faced there, and taps "I'm here". That pose is matched to the mark's pose
// exactly like a Continue scan's first pose is matched to its parent's last one (chain.js), so a
// nav walk recorded from that moment can join the map as just another scan.
import { apply, compose, invert, linkTransform, nudgeAbout, yawOf } from '../common/chain.js';
import { PROFILES, buildGrid, detectProfile } from '../common/grid.js';
import { TRAV, astar, simplifyPath, traversability } from '../common/trav.js';

export const NAV = {
  labelNear: 2.0, // m: a mark this close to a room label is named after it
  snapR: 1.5, // m: a start/goal in a blocked cell snaps to open floor this close
  turnDeg: 35, // heading change that counts as a turn (smaller bends: "keep going")
  slightDeg: 60, // below this a turn is "slight"
  mergeTurnS: 2.0, // m: route corners closer than this merge into one turn
  dirSpan: 1.0, // m of walked path either side of a room label that gives its "facing" direction
  offRoute: 1.5, // m from the route...
  offRouteS: 2.5, // ...for this long = off route, re-plan
  arrive: 1.0, // m from the goal = arrived
};

const ID = { yaw: 0, tx: 0, tz: 0 };
const idOf = (s, k) => s.header?.session_id ?? `scan${k}`;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Where a walker can start: the map's start marker plus the end mark of every scan (where the next
// scan of a chain would start). mergeMap's links say where each scan sits in the map.
//   scans: parsed scans of the map (as passed to mergeMap), merged: its result, labels: [{name, p}]
// Returns [{ id, name, kind: 'start'|'end', scan, T, local: {p, q}, p: [x, z], yaw }]:
//   T = scan-local -> map, local = the mark's pose in that scan's own coordinates.
export function startMarks(scans, merged, labels = []) {
  const T = new Map(merged.links.map((l) => [l.id, l.T]));
  const marks = [];
  const linked = new Set(merged.links.map((l) => l.id));
  const roots = scans.map((s, k) => [s, k]).filter(([s, k]) => s.frames.length && !linked.has(idOf(s, k)));
  const root = roots.sort((a, b) => ((a[0].header?.created || '') < (b[0].header?.created || '') ? -1 : 1))[0];
  const mk = (kind, s, k, f) => {
    const sid = idOf(s, k);
    const Ts = T.get(sid) || ID;
    const p = apply(Ts, f.p[0], f.p[2]);
    return { id: `${kind}:${sid}`, kind, scan: sid, T: Ts, local: { p: f.p, q: f.q }, p, yaw: Ts.yaw + yawOf(f.q) };
  };
  if (root) marks.push({ ...mk('start', root[0], root[1], root[0].frames[0]), name: 'Map start marker' });
  // Ends, oldest scan first; nav walks (header.nav) end wherever the walker stopped, not on a mark.
  scans.forEach((s, k) => {
    if (!s.frames.length || s.header?.nav) return;
    marks.push({ ...mk('end', s, k, s.frames.at(-1)), name: `End of scan ${idOf(s, k)}` });
  });
  for (const m of marks) {
    let best = null;
    for (const l of labels) {
      const d = dist(m.p, [l.p[0], l.p[2]]);
      if (d <= NAV.labelNear && (!best || d < best.d)) best = { d, l };
    }
    if (best) m.name = `${best.l.name} (${m.kind === 'start' ? 'map start marker' : 'end of scan ' + m.scan})`;
  }
  return [...roomMarks(merged.frames, labels), ...marks];
}

// Every room label is a start too: stand where you stood when you labelled it, facing the way
// you were walking then. The heading comes from the walked path either side of the label (not
// the phone's yaw: people turn to read the door sign). Rooms first, in number order.
// These marks are in map coordinates already (T = identity).
export function roomMarks(frames, labels) {
  const out = [];
  const timed = labels.filter((l) => Number.isFinite(l.t)).sort((a, b) => a.t - b.t);
  labels.forEach((l, k) => {
    const dir = travelHeading(frames, l);
    if (dir === null) return;
    const at = [l.p[0], l.p[2]];
    // "facing toward <the next room you labelled after it>", if that room is roughly ahead.
    const ahead = (o) => {
      const d = dist(at, [o.p[0], o.p[2]]);
      const off = Math.abs(wrap(headingOf(at, [o.p[0], o.p[2]]) - dir));
      return d > 1.5 && off < Math.PI / 4;
    };
    const behind = (o) => {
      const d = dist(at, [o.p[0], o.p[2]]);
      const off = Math.abs(wrap(headingOf(at, [o.p[0], o.p[2]]) - dir));
      return d > 1.5 && off > (3 * Math.PI) / 4;
    };
    const next = timed.find((o) => o.t > (l.t ?? Infinity) && o.name !== l.name && ahead(o)) || labels.find((o) => o !== l && o.name !== l.name && ahead(o));
    const prev = !next && ([...timed].reverse().find((o) => o.t < (l.t ?? -Infinity) && o.name !== l.name && behind(o)) || labels.find((o) => o !== l && o.name !== l.name && behind(o)));
    out.push({
      id: `room:${k}:${l.name}`,
      kind: 'room',
      scan: l.scan ?? null,
      T: ID,
      local: { p: [l.p[0], l.p[1], l.p[2]], q: [0, Math.sin(dir / 2), 0, Math.cos(dir / 2)] },
      p: at,
      yaw: dir,
      name: `Room ${l.name}`,
      hint: next ? `facing toward ${next.name}` : prev ? `with ${prev.name} behind you` : 'facing the way you walked when you labelled it',
    });
  });
  const num = (m) => parseFloat(m.name.replace(/^Room /, ''));
  return out.sort((a, b) => (num(a) - num(b)) || a.name.localeCompare(b.name));
}

// Walking direction at a label: from the path ~dirSpan m before to ~dirSpan m after the moment
// it was labelled (or the nearest path point, for labels added in the viewer). null if unknown.
function travelHeading(frames, l) {
  if (!frames.length) return null;
  let i0 = 0;
  if (Number.isFinite(l.t)) {
    let best = Infinity;
    frames.forEach((f, i) => {
      if (Math.abs(f.t - l.t) < best) (best = Math.abs(f.t - l.t)), (i0 = i);
    });
  } else {
    let best = Infinity;
    frames.forEach((f, i) => {
      const d = dist([f.p[0], f.p[2]], [l.p[0], l.p[2]]);
      if (d < best) (best = d), (i0 = i);
    });
  }
  const xz = (i) => [frames[i].p[0], frames[i].p[2]];
  // Walk out along the path, stopping at gaps between scans (time jumps or tracking jumps).
  const reach = (step) => {
    let i = i0;
    while (dist(xz(i), xz(i0)) < NAV.dirSpan) {
      const j = i + step;
      if (j < 0 || j >= frames.length || Math.abs(frames[j].t - frames[i].t) > 2 || dist(xz(j), xz(i)) > 1) break;
      i = j;
    }
    return i;
  };
  const a = xz(reach(-1)), b = xz(reach(1));
  if (dist(a, b) < 0.5) return yawOf(frames[i0].q); // stood still the whole time: the phone's heading
  return headingOf(a, b);
}

// Session -> map transform once the walker stands on `mark` with the viewer at sessPose {p, q}.
// Same maths as mergeMap's link + nudge, so a nudge found here means the same thing in the viewer.
export function sessionToMap(mark, sessPose, nudge = null) {
  let L = linkTransform(mark.local, sessPose); // session -> the mark scan's local coordinates
  if (nudge && (nudge.yawDeg || nudge.dx || nudge.dz)) {
    const pivot = apply(L, sessPose.p[0], sessPose.p[2]);
    L = compose(nudgeAbout(pivot[0], pivot[1], nudge), L);
  }
  return compose(mark.T, L);
}

// ---- map model: grid + traversability + start marks + destinations ----
// profile: 'person' | 'car' | 'auto' (from how high the phone rode while scanning)
export function buildNavMap(scans, merged, extraLabels = [], { profile = 'auto' } = {}) {
  const detected = detectProfile(merged.frames);
  const name = profile === 'auto' ? detected.profile : profile;
  const grid = buildGrid(merged.frames, PROFILES[name]);
  if (!grid) return null;
  const trav = traversability(grid);
  const labels = [...merged.labels, ...extraLabels].filter((l) => l?.name && Array.isArray(l.p));
  return { grid, trav, profile: name, detected, labels, marks: startMarks(scans, merged, labels) };
}

export function cellOf(grid, [x, z]) {
  const cx = Math.floor((x - grid.minX) / grid.cell), cz = Math.floor((z - grid.minZ) / grid.cell);
  if (cx < 0 || cz < 0 || cx >= grid.w || cz >= grid.h) return -1;
  return cz * grid.w + cx;
}

export const cellCenter = (grid, i) => [grid.minX + ((i % grid.w) + 0.5) * grid.cell, grid.minZ + (((i / grid.w) | 0) + 0.5) * grid.cell];

// Nearest passable cell within r metres (rings outward), or -1. Marks and labels often sit right
// against a wall or in a doorway the body-radius inflation closed.
export function snapToPassable(grid, cost, [x, z], r = NAV.snapR) {
  const i0 = cellOf(grid, [x, z]);
  if (i0 >= 0 && isFinite(cost[i0])) return i0;
  const cx = Math.floor((x - grid.minX) / grid.cell), cz = Math.floor((z - grid.minZ) / grid.cell);
  const R = Math.ceil(r / grid.cell);
  let best = -1, bestD = Infinity;
  for (let dz = -R; dz <= R; dz++) {
    for (let dx = -R; dx <= R; dx++) {
      const d = dx * dx + dz * dz;
      if (d > R * R || d >= bestD) continue;
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= grid.w || nz >= grid.h) continue;
      const i = nz * grid.w + nx;
      if (isFinite(cost[i])) {
        best = i;
        bestD = d;
      }
    }
  }
  return best;
}

// A* from `from` to `to` (map [x, z]). Returns { pts: [[x, z]...] string-pulled, length, walkedPct,
// snapped: {from, to} metres moved to reach open floor } or { error }.
export function planRoute(nav, from, to, cost = nav.trav.cost) {
  const { grid, trav } = nav;
  const a = snapToPassable(grid, cost, from), b = snapToPassable(grid, cost, to);
  if (a < 0) return { error: 'you are off the mapped floor here' };
  if (b < 0) return { error: 'that destination is not on mapped floor' };
  const cells = astar(cost, grid.w, grid.h, a, b);
  if (!cells) return { error: 'no route through mapped floor (the map may have a gap here)' };
  let length = 0, walked = 0;
  for (let k = 1; k < cells.length; k++) {
    const d = dist(cellCenter(grid, cells[k - 1]), cellCenter(grid, cells[k]));
    length += d;
    if (trav.tier[cells[k]] === TRAV.WALKED) walked += d;
  }
  const pts = straighten(simplifyPath(cells, cost, grid.w), cost, grid.w).map((i) => cellCenter(grid, i));
  // Start exactly where the walker is when that's open floor (no first hop to a cell centre).
  if (a === cellOf(grid, from)) pts[0] = [from[0], from[1]];
  if (pts.length < 2) pts.push([...pts[0]]); // already there: still a (zero-length) segment
  return {
    pts,
    length: pts.reduce((s, p, k) => (k ? s + dist(pts[k - 1], p) : 0), 0), // the straightened route walked
    gridLength: length,
    walkedPct: Math.round((100 * walked) / (length || 1)),
    snapped: { from: dist(from, cellCenter(grid, a)), to: dist(to, cellCenter(grid, b)) },
  };
}

// Hallways go straight: shortcut between route corners whenever every cell on the straight line
// is passable (open floor, already kept a body radius from obstacles). simplifyPath only cuts
// across equally cheap cells, so its route follows every sway of the walk that mapped it.
export function straighten(corners, cost, w) {
  if (!corners || corners.length < 3) return corners;
  const clear = (a, b) => {
    let x0 = a % w, z0 = (a / w) | 0;
    const x1 = b % w, z1 = (b / w) | 0;
    const dx = Math.abs(x1 - x0), dz = -Math.abs(z1 - z0);
    const sx = x0 < x1 ? 1 : -1, sz = z0 < z1 ? 1 : -1;
    let err = dx + dz;
    for (;;) {
      if (!isFinite(cost[z0 * w + x0])) return false;
      if (x0 === x1 && z0 === z1) return true;
      const e2 = 2 * err;
      if (e2 >= dz) { err += dz; x0 += sx; }
      if (e2 <= dx) { err += dx; z0 += sz; }
    }
  };
  const out = [corners[0]];
  let i = 0;
  while (i < corners.length - 1) {
    let j = corners.length - 1;
    while (j > i + 1 && !clear(corners[i], corners[j])) j--;
    out.push(corners[j]);
    i = j;
  }
  return out;
}

// ---- turn-by-turn ----
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// Heading of a step along the floor, same convention as chain.js (yaw 0 = -Z, + = turn left).
export const headingOf = (a, b) => Math.atan2(-(b[0] - a[0]), -(b[1] - a[1]));

// Turns along a route polyline: [{ s (m along the route), turn: radians (+ left), kind, text }],
// ending with an 'arrive' step. Corners closer together than mergeTurnS fold into one turn (the
// string-pulled path bends around a doorway in two short kinks).
export function turnList(pts) {
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + dist(pts[k - 1], pts[k]));
  const out = [];
  let k = 1;
  while (k < pts.length - 1) {
    const h0 = headingOf(pts[k - 1], pts[k]);
    let j = k;
    while (j + 1 < pts.length - 1 && cum[j + 1] - cum[k] < NAV.mergeTurnS) j++;
    const h1 = headingOf(pts[j], pts[j + 1]);
    const turn = wrap(h1 - h0);
    const deg = Math.abs(turn) * 180 / Math.PI;
    if (deg >= NAV.turnDeg) {
      const side = turn > 0 ? 'left' : 'right';
      const kind = deg < NAV.slightDeg ? `slight-${side}` : deg > 150 ? 'u-turn' : side;
      out.push({ s: (cum[k] + cum[j]) / 2, turn, kind, text: kind === 'u-turn' ? 'Turn around' : `Turn ${kind.replace('-', ' ')}` });
    }
    k = j + 1;
  }
  out.push({ s: cum.at(-1), turn: 0, kind: 'arrive', text: 'Arrive' });
  return { turns: out, cum, length: cum.at(-1) };
}

// Where the walker is along the route: { s, off (m from the route), seg, point }. Searches near the
// last known segment first so a route that doubles back doesn't jump ahead.
export function progressOn(pts, cum, xz, lastSeg = 0) {
  const bestOn = (from, to) => {
    let best = null;
    for (let k = Math.max(0, from); k < Math.min(pts.length - 1, to); k++) {
      const a = pts[k], b = pts[k + 1];
      const vx = b[0] - a[0], vz = b[1] - a[1];
      const L2 = vx * vx + vz * vz || 1e-9;
      const u = Math.max(0, Math.min(1, ((xz[0] - a[0]) * vx + (xz[1] - a[1]) * vz) / L2));
      const q = [a[0] + u * vx, a[1] + u * vz];
      const off = dist(q, xz);
      if (!best || off < best.off) best = { s: cum[k] + u * Math.sqrt(L2), off, seg: k, point: q };
    }
    return best;
  };
  const near = bestOn(lastSeg - 1, lastSeg + 4);
  if (near && near.off < NAV.offRoute) return near;
  return bestOn(0, pts.length) || near;
}

// The next turn ahead of s, and how far away it is.
export function nextTurn(turns, s) {
  const t = turns.find((x) => x.s > s - 0.3) || turns.at(-1);
  return { ...t, in: Math.max(0, t.s - s) };
}

// Plain-language steps for the 2D fallback: "Walk 6 m, turn left", ..., "Arrive".
export function stepsText(turnInfo, destName = 'your destination') {
  const out = [];
  let prev = 0;
  for (const t of turnInfo.turns) {
    const d = Math.max(1, Math.round(t.s - prev));
    out.push(t.kind === 'arrive' ? `Walk ${d} m to ${destName}` : `Walk ${d} m, then ${t.text.toLowerCase()}`);
    prev = t.s;
  }
  return out;
}

// Map points -> session points (for drawing in the AR session's coordinates).
export function mapToSession(T, [x, z]) {
  return apply(invert(T), x, z);
}
export { apply, invert };
