// Top-down map for the nav page: route preview, start marks, destinations, and the 2D fallback for
// phones without WebXR AR (iPhones). Canvas 2D; map X right, map Z down (same as the viewer).
import { TRAV } from '../common/trav.js';

const COLORS = { walked: [43, 196, 168], seen: [43, 196, 168], wall: [238, 242, 245] };

export class Map2D {
  constructor(canvas, { onTap } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.nav = null;
    this.image = null;
    this.route = null; // [[x, z], ...]
    this.dest = null; // { name, p: [x, z] }
    this.start = null; // mark
    this.you = null; // { p: [x, z], yaw }
    this.fitTo = 'route'; // 'route' | 'map'
    this.view = { s: 1, ox: 0, oz: 0 };
    canvas.addEventListener('click', (e) => {
      if (!onTap || !this.nav) return;
      const r = canvas.getBoundingClientRect();
      onTap(this.toMap(e.clientX - r.left, e.clientY - r.top));
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setMap(nav) {
    this.nav = nav;
    this.image = nav ? travImage(nav.grid, nav.trav) : null;
    this.draw();
  }

  toMap(px, py) {
    return [(px - this.view.ox) / this.view.s, (py - this.view.oz) / this.view.s];
  }

  // Scale/offset so the route (or the whole map) fills the canvas.
  fit(w, h) {
    const g = this.nav.grid;
    let box = [g.minX, g.minZ, g.minX + g.w * g.cell, g.minZ + g.h * g.cell];
    const pts = this.fitTo === 'route' && this.route ? [...this.route, ...(this.you ? [this.you.p] : [])] : null;
    if (pts) {
      box = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, z] of pts) box = [Math.min(box[0], x), Math.min(box[1], z), Math.max(box[2], x), Math.max(box[3], z)];
      const padM = 3;
      box = [box[0] - padM, box[1] - padM, box[2] + padM, box[3] + padM];
    }
    const s = Math.min(w / (box[2] - box[0]), h / (box[3] - box[1]));
    this.view = { s, ox: (w - s * (box[0] + box[2])) / 2, oz: (h - s * (box[1] + box[3])) / 2 };
  }

  draw() {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.nav) return;
    this.fit(w, h);
    const { s, ox, oz } = this.view;
    const X = (x) => ox + s * x, Z = (z) => oz + s * z;
    const g = this.nav.grid;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.image, X(g.minX), Z(g.minZ), g.w * g.cell * s, g.h * g.cell * s);

    if (this.route) {
      ctx.lineJoin = ctx.lineCap = 'round';
      for (const [width, color] of [[Math.max(6, s * 0.5), 'rgba(0,0,0,0.5)'], [Math.max(3.5, s * 0.3), '#f2b84b']]) {
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        ctx.beginPath();
        this.route.forEach(([x, z], k) => (k ? ctx.lineTo(X(x), Z(z)) : ctx.moveTo(X(x), Z(z))));
        ctx.stroke();
      }
    }
    const font = '600 13px system-ui, sans-serif';
    ctx.font = font;
    for (const l of this.nav.labels) {
      ctx.fillStyle = '#eef2f5';
      ctx.beginPath();
      ctx.arc(X(l.p[0]), Z(l.p[2]), 4, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillText(l.name, X(l.p[0]) + 7, Z(l.p[2]) + 4);
    }
    for (const m of this.nav.marks) this.drawPose(m.p, m.yaw, m === this.start ? '#2bc4a8' : 'rgba(238,242,245,0.55)', m === this.start ? 11 : 7);
    if (this.dest) {
      const [x, z] = this.dest.p;
      ctx.fillStyle = '#ef6b6b';
      ctx.beginPath();
      ctx.arc(X(x), Z(z), 8, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillStyle = '#eef2f5';
      ctx.fillText(this.dest.name, X(x) + 11, Z(z) - 8);
    }
    if (this.you) this.drawPose(this.you.p, this.you.yaw, '#5aa9ff', 12);
  }

  // A pose as a triangle pointing along its heading (yaw 0 = -Z = up on screen).
  drawPose([x, z], yaw, color, size) {
    const { ctx } = this;
    const { s, ox, oz } = this.view;
    const cx = ox + s * x, cz = oz + s * z;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw); // forward
    const rx = -fz, rz = fx; // right-hand side on screen
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx + fx * size, cz + fz * size);
    ctx.lineTo(cx - fx * size * 0.6 + rx * size * 0.7, cz - fz * size * 0.6 + rz * size * 0.7);
    ctx.lineTo(cx - fx * size * 0.6 - rx * size * 0.7, cz - fz * size * 0.6 - rz * size * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

// One pixel per cell: walked paths bright, floor seen faint, obstacles light grey.
function travImage(g, t) {
  const off = document.createElement('canvas');
  off.width = g.w;
  off.height = g.h;
  const octx = off.getContext('2d');
  const img = octx.createImageData(g.w, g.h);
  for (let i = 0; i < t.tier.length; i++) {
    const j = i * 4;
    if (t.tier[i] === TRAV.WALKED) {
      img.data.set(COLORS.walked, j);
      img.data[j + 3] = 200;
    } else if (t.tier[i] === TRAV.SEEN) {
      img.data.set(COLORS.seen, j);
      img.data[j + 3] = 60;
    } else if (t.occ[i]) {
      img.data.set(COLORS.wall, j);
      img.data[j + 3] = 190;
    }
  }
  octx.putImageData(img, 0, 0);
  return off;
}
