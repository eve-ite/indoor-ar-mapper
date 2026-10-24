// "Map" mode: Google-Maps-style rendering of the traversability grid. The raw 5 cm cells are
// blurred and re-thresholded at SS x resolution so floors, paths and obstacles get smooth,
// anti-aliased outlines instead of speckle.
import { TRAV } from '../common/trav.js';

const SS = 4; // output pixels per grid cell

function blur(src, w, h, r, passes) {
  let a = Float32Array.from(src);
  let b = new Float32Array(a.length);
  const n = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += a[z * w + Math.min(w - 1, Math.max(0, x + k))];
        b[z * w + x] = s / n;
      }
    }
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += b[Math.min(h - 1, Math.max(0, z + k)) * w + x];
        a[z * w + x] = s / n;
      }
    }
  }
  return a;
}

const smooth = (e0, e1, v) => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// Upsample a field bilinearly and colour it: bands = [[threshold, [r,g,b]], ...] highest first.
function paint(field, w, h, bands) {
  const W = w * SS, H = h * SS;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const cx = c.getContext('2d');
  const img = cx.createImageData(W, H);
  const aa = 0.06; // anti-alias width in field units
  for (let v = 0; v < H; v++) {
    const gz = (v + 0.5) / SS - 0.5;
    const z0 = Math.max(0, Math.min(h - 1, Math.floor(gz))), z1 = Math.min(h - 1, z0 + 1), fz = Math.min(1, Math.max(0, gz - z0));
    for (let u = 0; u < W; u++) {
      const gx = (u + 0.5) / SS - 0.5;
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(gx))), x1 = Math.min(w - 1, x0 + 1), fx = Math.min(1, Math.max(0, gx - x0));
      const top = field[z0 * w + x0] * (1 - fx) + field[z0 * w + x1] * fx;
      const bot = field[z1 * w + x0] * (1 - fx) + field[z1 * w + x1] * fx;
      const val = top * (1 - fz) + bot * fz;
      const lowest = bands[bands.length - 1][0];
      if (val < lowest - aa) continue;
      let col = bands[bands.length - 1][1];
      for (const [t, rgb] of bands) {
        if (val >= t) {
          col = rgb;
          break;
        }
      }
      const j = (v * W + u) * 4;
      img.data[j] = col[0];
      img.data[j + 1] = col[1];
      img.data[j + 2] = col[2];
      img.data[j + 3] = Math.round(255 * smooth(lowest - aa, lowest + aa, val));
    }
  }
  cx.putImageData(img, 0, 0);
  return c;
}

function rgb(css) {
  const n = parseInt(css.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function morph(mask, w, h, r, grow) {
  const out = new Float32Array(w * h);
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
const close = (mask, w, h, r) => morph(morph(mask, w, h, r, true), w, h, r, false);

// Drop 4-connected islands smaller than minCells. Display only: routing still sees them.
function dropSpecks(mask, w, h, minCells) {
  const out = Float32Array.from(mask);
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

const MIN_OBSTACLE_CELLS = 10; // 10 x 5 cm cells = 2.5 dm²

// Returns offscreen canvases covering the grid extent: floor, paths ("roads"), obstacles.
export function buildMapLayers(grid, trav, color) {
  const { w, h } = grid;
  const known = new Float32Array(w * h);
  const walked = new Float32Array(w * h);
  const occ = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    known[i] = trav.tier[i] !== TRAV.BLOCKED || trav.occ[i] ? 1 : 0;
    walked[i] = trav.tier[i] === TRAV.WALKED ? 1 : 0;
    occ[i] = trav.occ[i] ? 1 : 0;
  }
  return {
    floor: paint(blur(close(known, w, h, 2), w, h, 2, 2), w, h, [[0.5, rgb(color('--map-floor'))]]),
    roads: paint(blur(walked, w, h, 1, 2), w, h, [
      [0.55, rgb(color('--map-road'))],
      [0.22, rgb(color('--map-road-edge'))],
    ]),
    // Low threshold merges speckled depth hits into solid blobs, like building footprints.
    obstacles: paint(blur(dropSpecks(close(occ, w, h, 3), w, h, MIN_OBSTACLE_CELLS), w, h, 1, 2), w, h, [
      [0.4, rgb(color('--map-obst'))],
      [0.28, rgb(color('--map-obst-edge'))],
    ]),
  };
}

// Chaikin corner cutting for a polyline of [x, y] screen points.
export function chaikin(pts, iterations = 3) {
  let p = pts;
  for (let it = 0; it < iterations && p.length > 2; it++) {
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, ay] = p[i], [bx, by] = p[i + 1];
      q.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by], [0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

// Destination pin: teardrop with a dot, tip at (x, y).
export function drawPin(ctx, x, y, fill, dot) {
  const r = 11;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.bezierCurveTo(x - 4, y - 8, x - r, y - 12, x - r, y - 2.2 * r + 2);
  ctx.arc(x, y - 2.2 * r + 2, r, Math.PI, 0);
  ctx.bezierCurveTo(x + r, y - 12, x + 4, y - 8, x, y);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = dot;
  ctx.beginPath();
  ctx.arc(x, y - 2.2 * r + 2, 4, 0, Math.PI * 2);
  ctx.fill();
}

// Origin marker: white ring around a filled dot.
export function drawOrigin(ctx, x, y, ring, fill) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 3;
  ctx.fillStyle = ring;
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fill();
}

// Compass: "up" on the map is the start marker's forward direction (-Z).
export function drawCompass(ctx, x, y, bg, fg, accent) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 4;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(x, y, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(x, y - 13);
  ctx.lineTo(x + 5, y);
  ctx.lineTo(x - 5, y);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.moveTo(x, y + 13);
  ctx.lineTo(x + 5, y);
  ctx.lineTo(x - 5, y);
  ctx.fill();
  ctx.globalAlpha = 1;
}
