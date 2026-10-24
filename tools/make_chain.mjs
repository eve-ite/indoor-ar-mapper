// Split a synthetic scan into a 2-scan chain (B continues A) like the scan app records them:
// B has its own session frame, and its start is `--err yawDeg,dx,dz` away from where A ended.
//   node tools/make_chain.mjs scans/synthetic_depth.jsonl scans/chain [--err 4,0.15,-0.1]
import { readFileSync, writeFileSync } from 'fs';
import { parseScan } from '../web/common/jsonl.js';
import { compose, invert, poseToT, transformFrame } from '../web/common/chain.js';

const [src = 'scans/synthetic_depth.jsonl', out = 'scans/chain'] = process.argv.slice(2).filter((a) => !a.startsWith('--') && !/^-?[\d.]+,/.test(a));
const errArg = process.argv.includes('--err') ? process.argv[process.argv.indexOf('--err') + 1] : '0,0,0';
const [yawDeg, dx, dz] = errArg.split(',').map(Number);
const scan = parseScan(readFileSync(src, 'utf8'));
const cut = Math.floor(scan.frames.length * 0.55);
const truth = scan.frames.slice(cut - 1);

// A ends at the pose the user marked; B truly starts at truth[0], off by err from that mark.
const S = poseToT(truth[0].p, truth[0].q);
const Send = compose(S, { yaw: (yawDeg * Math.PI) / 180, tx: dx, tz: dz });
const qYaw = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const lastA = { ...scan.frames[cut - 1], p: [Send.tx, scan.frames[cut - 1].p[1], Send.tz], q: qYaw(Send.yaw) };
const aFrames = [...scan.frames.slice(0, cut - 1), lastA];
const bFrames = truth.map((f) => transformFrame(f, invert(S), 0, -truth[0].t));

const ida = `${out.split('/').pop()}_a`, idb = `${out.split('/').pop()}_b`;
const line = (o) => JSON.stringify(o) + '\n';
const headA = { ...scan.header, session_id: ida };
const headB = { ...scan.header, session_id: idb, created: '2026-10-24T10:05:00Z', continues: ida, continues_end: { p: lastA.p, q: lastA.q }, chain: ida };
writeFileSync(`${out}_a.jsonl`, line(headA) + aFrames.map(line).join(''));
writeFileSync(`${out}_b.jsonl`, line(headB) + bFrames.map(line).join(''));
console.log(`wrote ${out}_a.jsonl (${aFrames.length} frames) and ${out}_b.jsonl (${bFrames.length} frames, continues ${ida}); handover error ${yawDeg}°, ${dx} m, ${dz} m`);
