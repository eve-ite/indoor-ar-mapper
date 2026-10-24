// 3D map view: obstacles as extruded blocks at their scanned height, floor as a plane (walked
// paths tinted), route as a tube. Orbit with mouse/touch; a click on the floor reports (x, z).
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { TRAV } from '../common/trav.js';
import { close, dropSpecks } from './mapstyle.js';
import { wallMask } from '../common/plan.js';

const PLAN_WALL_H = 1.2; // m: uniform wall height in floor-plan mode (reads like a plan, not a skyline)

const BLOCK = 2; // grid cells per block side (2 x 5 cm = 10 cm blocks)
const MIN_OBSTACLE_CELLS = 10; // hide specks under 2.5 dm² (routing still sees them)
const MIN_BLOCK_H = 0.1; // m; obstacles are at least this tall when drawn
const ROUTE_Y = 0.06; // m above the floor

export class View3D {
  constructor(container, color) {
    this.container = container;
    this.color = color; // (cssVarName) => '#rrggbb'
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05; // stay above the floor
    this.controls.addEventListener('change', () => this.render());

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x666666, 1.6);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.hemi, this.sun, this.sun.target);

    this.mapGroup = new THREE.Group();
    this.routeGroup = new THREE.Group();
    this.labelGroup = new THREE.Group(); // room labels: name tag on a post
    this.scene.add(this.mapGroup, this.routeGroup, this.labelGroup);
    this.floorPlan = false;

    this.onPick = null;
    this.pickFloor();
    this.applyTheme();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const tick = () => {
      if (this.controls.update()) this.render();
      requestAnimationFrame(tick);
    };
    tick();
  }

  applyTheme() {
    this.themeVersion = (this.themeVersion || 0) + 1; // built map groups use theme colours: rebuild
    this.scene.background = new THREE.Color(this.color('--map-unknown'));
    this.render();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  // Click (not drag) on the floor plane -> onPick(x, z).
  pickFloor() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || !this.onPick) return;
      down = null;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const hit = new THREE.Vector3();
      if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) this.onPick(hit.x, hit.z);
    });
  }

  clear(group) {
    for (const o of [...group.children]) {
      group.remove(o);
      o.geometry?.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => (m.map?.dispose(), m.dispose()));
    }
  }

  // Floor-plan mode: structure only (walls), uniform height, plain floor. Display-only.
  setFloorPlan(on) {
    this.floorPlan = on;
  }

  // Builds (or reuses) the map for the current mode. Both the normal and the floor-plan version are
  // kept once built, so toggling floor plan just swaps which one is shown.
  setMap(grid, trav) {
    const key = this.floorPlan ? 'plan' : 'normal';
    if (this.built?.trav !== trav || this.built?.theme !== this.themeVersion) {
      for (const g of [this.built?.plan, this.built?.normal]) if (g) this.clear(g);
      this.built = { trav, theme: this.themeVersion };
    }
    this.grid = grid;
    if (!this.built[key]) this.built[key] = this.buildMap(grid, trav);
    this.mapGroup.remove(...this.mapGroup.children); // detach only: built groups are reused
    this.mapGroup.add(this.built[key]);
    this.blockCount = this.built[key].userData.blockCount;
    this.render();
    // Pre-build the other version while the browser is idle, so the first toggle is instant too.
    const other = this.floorPlan ? 'normal' : 'plan';
    const built = this.built;
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 300));
    idle(() => {
      if (this.built === built && !built[other]) built[other] = this.buildMap(grid, trav);
    });
  }

  buildMap(grid, trav) {
    const group = new THREE.Group();
    const { w, h, cell, minX, minZ } = grid;

    // Floor: one texel per cell, unknown transparent, walked tinted.
    const tex = document.createElement('canvas');
    tex.width = w;
    tex.height = h;
    const tctx = tex.getContext('2d');
    const img = tctx.createImageData(w, h);
    const floorRGB = rgb(this.color('--map-floor'));
    const walkRGB = rgb(this.color('--map-road'));
    // Cleaned masks depend only on (grid, trav): cache them so toggling floor plan / theme doesn't
    // redo the clean-up on a multi-million-cell venue grid.
    if (this.cache?.trav !== trav) this.cache = { trav };
    const cached = (key, make) => (this.cache[key] ??= make());
    const known = cached('known', () => close(Uint8Array.from(trav.tier, (t, i) => (t !== TRAV.BLOCKED || trav.occ[i] ? 1 : 0)), w, h, 2));
    for (let i = 0; i < w * h; i++) {
      if (!known[i]) continue;
      img.data.set(trav.tier[i] === TRAV.WALKED && !this.floorPlan ? walkRGB : floorRGB, i * 4);
      img.data[i * 4 + 3] = 255;
    }
    tctx.putImageData(img, 0, 0);
    const texture = new THREE.CanvasTexture(tex);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w * cell, h * cell),
      new THREE.MeshLambertMaterial({ map: texture, transparent: true, alphaTest: 0.5 }),
    );
    floor.rotation.x = -Math.PI / 2; // plane's +Y (texture top) -> -Z, so texture row 0 = minZ
    floor.position.set(minX + (w * cell) / 2, 0, minZ + (h * cell) / 2);
    floor.receiveShadow = true;
    group.add(floor);

    // Blocks: obstacle mask cleaned up, then one box per BLOCK x BLOCK group of cells.
    const mask = this.floorPlan
      ? cached('walls', () => dropSpecks(close(wallMask(grid, trav.occ), w, h, 3), w, h, MIN_OBSTACLE_CELLS))
      : cached('obstacles', () => dropSpecks(close(Uint8Array.from(trav.occ), w, h, 3), w, h, MIN_OBSTACLE_CELLS));
    const blocks = [];
    for (let bz = 0; bz < h; bz += BLOCK) {
      for (let bx = 0; bx < w; bx += BLOCK) {
        const tops = [];
        let any = false;
        for (let z = bz; z < Math.min(h, bz + BLOCK); z++) {
          for (let x = bx; x < Math.min(w, bx + BLOCK); x++) {
            const i = z * w + x;
            if (!mask[i]) continue;
            any = true;
            if (grid.obsTop[i] > 0) tops.push(grid.obsTop[i]);
          }
        }
        if (!any) continue;
        tops.sort((a, b) => a - b);
        // Median of the cells' tallest hits; cells filled in by closing borrow the neighbourhood's.
        blocks.push({ bx, bz, top: tops.length ? tops[tops.length >> 1] : null });
      }
    }
    // Give filled-in blocks (no hits of their own) the height of nearby blocks.
    const known3 = blocks.filter((b) => b.top !== null);
    for (const b of blocks) {
      if (b.top !== null) continue;
      let best = null, bestD = Infinity;
      for (const k of known3) {
        const d = Math.abs(k.bx - b.bx) + Math.abs(k.bz - b.bz);
        if (d < bestD) (bestD = d), (best = k);
      }
      b.top = best ? best.top : 0.75;
    }
    // Depth noise makes neighbouring tops ragged: use the median of each block's 3x3 neighbourhood.
    const byKey = new Map(blocks.map((b) => [`${b.bx},${b.bz}`, b.top]));
    for (const b of blocks) {
      const near = [];
      for (let dz = -BLOCK; dz <= BLOCK; dz += BLOCK) {
        for (let dx = -BLOCK; dx <= BLOCK; dx += BLOCK) {
          const t = byKey.get(`${b.bx + dx},${b.bz + dz}`);
          if (t !== undefined) near.push(t);
        }
      }
      near.sort((p, q) => p - q);
      b.smoothTop = near[near.length >> 1];
    }

    const size = BLOCK * cell;
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0); // origin at the base so scale.y = height
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
    const mesh = new THREE.InstancedMesh(box, mat, Math.max(1, blocks.length));
    mesh.count = blocks.length;
    mesh.castShadow = mesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    const low = new THREE.Color(this.color('--map-obst'));
    const high = new THREE.Color(this.color('--map-obst-edge'));
    const c = new THREE.Color();
    blocks.forEach((b, k) => {
      const hgt = this.floorPlan ? PLAN_WALL_H : Math.max(MIN_BLOCK_H, b.smoothTop);
      m.makeScale(size * 0.98, hgt, size * 0.98);
      m.setPosition(minX + (b.bx + BLOCK / 2) * cell, 0, minZ + (b.bz + BLOCK / 2) * cell);
      mesh.setMatrixAt(k, m);
      mesh.setColorAt(k, c.copy(low).lerp(high, Math.min(1, hgt / 2)));
    });
    group.add(mesh);

    // Start marker: flat ring at the origin.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.12, 0.17, 32),
      new THREE.MeshBasicMaterial({ color: this.color('--map-start'), side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01;
    group.add(ring);

    // Sun + shadow camera cover the map.
    const cx = minX + (w * cell) / 2, cz = minZ + (h * cell) / 2, span = Math.max(w, h) * cell;
    this.sun.position.set(cx - span * 0.4, span, cz + span * 0.3);
    this.sun.target.position.set(cx, 0, cz);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -span * 0.75;
    sc.right = sc.top = span * 0.75;
    sc.near = 0.1;
    sc.far = span * 3;
    sc.updateProjectionMatrix();
    group.userData.blockCount = blocks.length;
    return group;
  }

  // labels: [{ name, p: [x, y, z] }]. A name tag on a thin post at each spot, always readable.
  setLabels(labels) {
    this.clear(this.labelGroup);
    for (const l of labels || []) {
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      const font = 'bold 44px system-ui, sans-serif';
      ctx.font = font;
      const tw = Math.ceil(ctx.measureText(l.name).width);
      c.width = tw + 40;
      c.height = 72;
      ctx.font = font;
      ctx.fillStyle = this.color('--map-route');
      ctx.beginPath();
      ctx.roundRect(0, 0, c.width, c.height, 18);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(l.name, 20, c.height / 2 + 2);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false }));
      const hPx = 0.045; // fraction of the view height: tags stay readable at any zoom
      tag.scale.set((hPx * c.width) / c.height, hPx, 1);
      tag.position.set(l.p[0], 1.6, l.p[2]);
      tag.renderOrder = 10;
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.02, 0.02, 1.6, 8),
        new THREE.MeshStandardMaterial({ color: this.color('--map-route') }),
      );
      post.position.set(l.p[0], 0.8, l.p[2]);
      post.castShadow = true;
      this.labelGroup.add(tag, post);
    }
    this.render();
  }

  // pts: [[x, z], ...] world points of the route (already smoothed); a/b: [x, z] or null.
  setRoute(pts, a, b) {
    this.clear(this.routeGroup);
    const routeColor = this.color('--map-route');
    if (pts && pts.length > 1) {
      const curve = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, ROUTE_Y, z)));
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, Math.max(16, pts.length * 4), 0.04, 8, false),
        new THREE.MeshStandardMaterial({ color: routeColor, emissive: routeColor, emissiveIntensity: 0.35 }),
      );
      tube.castShadow = true;
      this.routeGroup.add(tube);
    }
    const marker = (p, col, tall) => {
      const g = new THREE.Group();
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, tall, 8), new THREE.MeshStandardMaterial({ color: col }));
      stem.position.y = tall / 2;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), new THREE.MeshStandardMaterial({ color: col }));
      head.position.y = tall;
      stem.castShadow = head.castShadow = true;
      g.add(stem, head);
      g.position.set(p[0], 0, p[1]);
      this.routeGroup.add(g);
    };
    if (a) marker(a, routeColor, 0.35);
    if (b) marker(b, this.color('--map-pin'), 0.5);
    this.render();
  }

  // Tilted view of the whole map, looking toward the start marker's forward (-Z) direction.
  fit() {
    if (!this.grid) return;
    const { w, h, cell, minX, minZ } = this.grid;
    const cx = minX + (w * cell) / 2, cz = minZ + (h * cell) / 2;
    // Distance so the whole footprint fits the (vertical) field of view, then some.
    const span = Math.max((w * cell) / this.camera.aspect, h * cell, 2);
    const dist = (span / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.15;
    const tilt = THREE.MathUtils.degToRad(35); // from vertical: steep enough to see over walls
    // Clipping range sized to the map: a fixed 200 m far plane cut off the far end of a tilted
    // ~110 m venue chain. Zoom-out is capped so the far plane always covers the whole map.
    const diag = Math.hypot(w * cell, h * cell);
    this.controls.maxDistance = Math.max(dist * 3, 20);
    this.camera.far = this.controls.maxDistance + diag + 10;
    this.camera.near = Math.max(0.02, dist / 4000);
    this.camera.updateProjectionMatrix();
    this.controls.target.set(cx, 0, cz);
    this.camera.position.set(cx, dist * Math.cos(tilt), cz + dist * Math.sin(tilt));
    this.controls.update();
    this.render();
  }

  topDown() {
    const t = this.controls.target, d = this.camera.position.distanceTo(t);
    this.camera.position.set(t.x, d, t.z + 0.001);
    this.controls.update();
    this.render();
  }

  zoom(k) {
    const t = this.controls.target;
    this.camera.position.sub(t).multiplyScalar(1 / k).add(t);
    this.controls.update();
    this.render();
  }
}

function rgb(css) {
  const n = parseInt(css.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
