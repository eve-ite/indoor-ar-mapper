// AR drawing maths for the nav page, with the real three.js: the route group (map coords inside,
// map -> session transform outside) lands map points where navcore says, and chevrons point along
// the route.   node tools/test_nav_ar.mjs
import * as THREE from '../web/vendor/three.module.min.js';
import { headingOf, invert, mapToSession } from '../web/nav/navcore.js';

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
  if (!ok) failed++;
};

// Same set-up as nav.js: routeGroup.rotation.y = invert(T).yaw, position = invert(T).t
const T = { yaw: 0.8, tx: -4.2, tz: 11.5 }; // session -> map
const Ti = invert(T);
const group = new THREE.Group();
group.rotation.y = Ti.yaw;
group.position.set(Ti.tx, 0, Ti.tz);
group.updateMatrixWorld(true);
let err = 0;
for (const p of [[0, 0], [3, -7], [-12.5, 4.25]]) {
  const v = group.localToWorld(new THREE.Vector3(p[0], 0, p[1]));
  const want = mapToSession(T, p);
  err = Math.max(err, Math.hypot(v.x - want[0], v.z - want[1]));
}
check('route group puts map points where mapToSession does', err < 1e-9, `max ${err.toExponential(1)}`);

// The chevron: tip at shape +Y, laid flat, must point along -Z; rotated by a route heading it
// must point along that route step.
const s = new THREE.Shape();
s.moveTo(0, 0.22);
s.lineTo(0.2, -0.06);
s.lineTo(0.2, -0.16);
s.lineTo(0, 0.08);
s.lineTo(-0.2, -0.16);
s.lineTo(-0.2, -0.06);
s.closePath();
const g = new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2);
const pos = g.attributes.position;
let tip = null;
for (let i = 0; i < pos.count; i++) if (!tip || pos.getZ(i) < tip.z) tip = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
check('chevron lies flat with its tip toward -Z', Math.abs(tip.y) < 1e-9 && tip.z < -0.2 && Math.abs(tip.x) < 1e-9);
g.computeVertexNormals();
check('chevron faces up', g.attributes.normal.getY(0) > 0.99);
for (const [a, b] of [[[0, 0], [3, 0]], [[0, 0], [0, 3]], [[1, 1], [-2, -2]]]) {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), headingOf(a, b));
  const t = tip.clone().applyQuaternion(q).normalize();
  const d = new THREE.Vector3(b[0] - a[0], 0, b[1] - a[1]).normalize();
  check(`chevron points along ${JSON.stringify(a)} -> ${JSON.stringify(b)}`, t.dot(d) > 0.999, `dot ${t.dot(d).toFixed(3)}`);
}

console.log(failed ? `FAIL (${failed})` : 'PASS');
process.exit(failed ? 1 : 0);
