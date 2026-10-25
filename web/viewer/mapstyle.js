// Mask clean-up shared by the 3D view: turns speckled obstacle cells into solid shapes.

// Chamfer (3-4) distance, in cells, from every cell to the nearest cell where target(i) is true.
// Two raster passes: O(cells) whatever the radius (the old disk loop was O(cells x r^2), seconds
// on a 5 M-cell venue grid). outsideIsTarget: treat cells beyond the border as targets.
function chamfer(target, w, h, outsideIsTarget) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = target(i) ? 0 : INF;
  const edge = outsideIsTarget ? 0 : INF;
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      let v = d[i];
      if (v === 0) continue;
      v = Math.min(v, (x > 0 ? d[i - 1] : edge) + 3);
      if (z > 0) {
        v = Math.min(v, d[i - w] + 3, (x > 0 ? d[i - w - 1] : edge) + 4, (x < w - 1 ? d[i - w + 1] : edge) + 4);
      } else {
        v = Math.min(v, edge + 3);
      }
      d[i] = v;
    }
  }
  for (let z = h - 1; z >= 0; z--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = z * w + x;
      let v = d[i];
      if (v === 0) continue;
      v = Math.min(v, (x < w - 1 ? d[i + 1] : edge) + 3);
      if (z < h - 1) {
        v = Math.min(v, d[i + w] + 3, (x < w - 1 ? d[i + w + 1] : edge) + 4, (x > 0 ? d[i + w - 1] : edge) + 4);
      } else {
        v = Math.min(v, edge + 3);
      }
      d[i] = v;
    }
  }
  return d; // units: 3 per cell
}

// Morphological closing with a radius-r disk: fills holes up to ~2r cells (e.g. a table top only
// hit at its edges). Dilate = within r of a set cell; erode = farther than r from an unset cell
// (cells past the border count as unset, as before).
export function close(mask, w, h, r) {
  const R = 3 * r;
  const toSet = chamfer((i) => mask[i], w, h, false);
  const toUnset = chamfer((i) => toSet[i] > R, w, h, true);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = toUnset[i] > R ? 1 : 0;
  return out;
}

// Drop 4-connected islands smaller than minCells (stray depth hits). Display only.
export function dropSpecks(mask, w, h, minCells) {
  const out = Uint8Array.from(mask);
  const seen = new Uint8Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!out[start] || seen[start]) continue;
    const comp = [start];
    seen[start] = 1;
    for (let k = 0; k < comp.length; k++) {
      const i = comp[k], x = i % w, z = (i / w) | 0;
      for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
        const n = nz * w + nx;
        if (nx >= 0 && nz >= 0 && nx < w && nz < h && out[n] && !seen[n]) {
          seen[n] = 1;
          comp.push(n);
        }
      }
    }
    if (comp.length < minCells) for (const i of comp) out[i] = 0;
  }
  return out;
}
