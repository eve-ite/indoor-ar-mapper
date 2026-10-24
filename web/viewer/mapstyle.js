// Mask clean-up shared by the 3D view: turns speckled obstacle cells into solid shapes.

function morph(mask, w, h, r, grow) {
  const out = new Uint8Array(w * h);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      let hit = !grow;
      for (let dz = -r; dz <= r && hit !== grow; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dz * dz > r * r) continue;
          const nx = x + dx, nz = z + dz;
          const v = nx >= 0 && nz >= 0 && nx < w && nz < h ? mask[nz * w + nx] : 0;
          if (grow ? v : !v) {
            hit = grow;
            break;
          }
        }
      }
      out[z * w + x] = hit ? 1 : 0;
    }
  }
  return out;
}

// Morphological closing: fills holes up to ~2r cells (e.g. a table top only hit at its edges).
export const close = (mask, w, h, r) => morph(morph(mask, w, h, r, true), w, h, r, false);

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
