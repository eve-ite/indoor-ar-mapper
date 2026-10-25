// Colour the floor grid from keyframe photos: each floor cell centre (x, floor, z) is projected
// into every nearby photo that can see it, and the pixel colours are blended, favouring close,
// steep (head-on) views. Cells hidden behind an obstacle taller than the sight line are skipped.
import { poseMatrix, projectToImage } from '../common/keyframes.js';

const MAX_RANGE = 4; // m from the camera (floor detail is mush further out)
const MARCH_STEP = 2; // cells per occlusion-check step

// keyframes: [{ p, q, intrinsics, t, image: ImageData }]; floorAt(t) -> floor y at time t.
// Returns RGBA per grid cell (alpha 0 = no photo saw it).
export function floorColors(grid, trav, keyframes, floorAt) {
  const { w, h, cell, minX, minZ, obsTop } = grid;
  const sum = new Float32Array(w * h * 3);
  const wsum = new Float32Array(w * h);

  for (const kf of keyframes) {
    const img = kf.image;
    if (!img) continue;
    const K = kf.intrinsics;
    // Photos may have been downscaled after capture: scale intrinsics to the decoded size.
    const sx = img.width / K.w, sy = img.height / K.h;
    const Ks = { fx: K.fx * sx, fy: K.fy * sy, cx: K.cx * sx, cy: K.cy * sy };
    const M = poseMatrix(kf.p, kf.q);
    const floor = floorAt(kf.t);
    const camH = kf.p[1] - floor;
    if (camH <= 0.05) continue;
    const ccx = (kf.p[0] - minX) / cell, ccz = (kf.p[2] - minZ) / cell;
    const r = Math.ceil(MAX_RANGE / cell);
    const x0 = Math.max(0, Math.floor(ccx - r)), x1 = Math.min(w - 1, Math.ceil(ccx + r));
    const z0 = Math.max(0, Math.floor(ccz - r)), z1 = Math.min(h - 1, Math.ceil(ccz + r));

    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const i = cz * w + cx;
        if (trav.occ[i]) continue; // obstacle footprint: not floor
        const wx = minX + (cx + 0.5) * cell, wz = minZ + (cz + 0.5) * cell;
        const dx = wx - kf.p[0], dz = wz - kf.p[2];
        const dist = Math.hypot(dx, dz);
        if (dist > MAX_RANGE) continue;
        const uv = projectToImage(M, Ks, [wx, floor, wz]);
        if (!uv) continue;
        const u = Math.floor(uv[0]), v = Math.floor(uv[1]);
        if (u < 0 || v < 0 || u >= img.width || v >= img.height) continue;
        if (occluded(grid, trav, ccx, ccz, cx + 0.5, cz + 0.5, camH)) continue;

        // Steeper views (camera above the cell) and closer ones are sharper and less distorted.
        const steep = camH / Math.hypot(dist, camH);
        const wgt = (steep * steep) / (dist * dist + 0.3);
        const j = (v * img.width + u) * 4;
        sum[i * 3] += img.data[j] * wgt;
        sum[i * 3 + 1] += img.data[j + 1] * wgt;
        sum[i * 3 + 2] += img.data[j + 2] * wgt;
        wsum[i] += wgt;
      }
    }
  }

  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (!wsum[i]) continue;
    out[i * 4] = sum[i * 3] / wsum[i];
    out[i * 4 + 1] = sum[i * 3 + 1] / wsum[i];
    out[i * 4 + 2] = sum[i * 3 + 2] / wsum[i];
    out[i * 4 + 3] = 255;
  }
  return out;

  // Does an obstacle stand taller than the sight line between the camera and this floor cell?
  function occluded(g, t, ax, az, bx, bz, camH) {
    const steps = Math.max(1, Math.floor(Math.hypot(bx - ax, bz - az) / MARCH_STEP));
    for (let s = 1; s < steps; s++) {
      const f = s / steps;
      const x = Math.floor(ax + (bx - ax) * f), z = Math.floor(az + (bz - az) * f);
      if (x < 0 || z < 0 || x >= g.w || z >= g.h) continue;
      const k = z * g.w + x;
      if (t.occ[k] && (obsTop[k] || 0.75) > camH * (1 - f)) return true; // sight line height at f
    }
    return false;
  }
}
