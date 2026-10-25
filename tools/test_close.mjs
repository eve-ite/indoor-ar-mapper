// close() (map clean-up) check: the fast chamfer version must match a reference disk closing
// on random speckled masks, and be fast on a big grid.
//   node tools/test_close.mjs
import { close } from '../web/viewer/mapstyle.js';

// Reference: the original disk-by-disk implementation (slow, exact disk).
function morphRef(mask, w, h, r, grow) {
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
const closeRef = (m, w, h, r) => morphRef(morphRef(m, w, h, r, true), w, h, r, false);

let worst = 0;
for (let trial = 0; trial < 5; trial++) {
  const w = 300, h = 220, m = new Uint8Array(w * h);
  let seed = trial * 7 + 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 900; k++) {
    const cx = Math.floor(rnd() * w), cz = Math.floor(rnd() * h), s = 1 + Math.floor(rnd() * 6);
    for (let z = cz; z < Math.min(h, cz + s); z++) for (let x = cx; x < Math.min(w, cx + s); x++) if (rnd() < 0.6) m[z * w + x] = 1;
  }
  for (const r of [2, 3]) {
    const a = closeRef(m, w, h, r), b = close(m, w, h, r);
    let diff = 0, set = 0;
    for (let i = 0; i < a.length; i++) {
      diff += a[i] !== b[i];
      set += a[i];
    }
    worst = Math.max(worst, diff / set);
  }
}
const big = new Uint8Array(2000 * 2500);
for (let i = 0; i < big.length; i += 37) big[i] = 1;
const t0 = performance.now();
close(big, 2000, 2500, 3);
const ms = performance.now() - t0;
console.log(`differs from the reference disk closing on ${(100 * worst).toFixed(2)}% of cells (worst); 5 M-cell grid in ${ms.toFixed(0)} ms`);
const ok = worst < 0.03 && ms < 1000;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
