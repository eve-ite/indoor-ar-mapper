// "Newest wins" test: visit1 walks the room with the table at its original spot; visit2 (two
// minutes later) sees the table moved onto visit1's walked path.
//   python tools/make_synthetic.py scans/visit1.jsonl --depth --id visit1
//   python tools/make_synthetic.py scans/visit2.jsonl --depth --id visit2 --t0 120 --path short --sway 0.9 --table -1.5,-3.4,-0.9,-2.8
//   node tools/test_moved.mjs
import { readFileSync } from 'fs';
import { parseScan } from '../web/common/jsonl.js';
import { buildGrid } from '../web/common/grid.js';
import { TRAV, traversability } from '../web/common/trav.js';

const v1 = parseScan(readFileSync('scans/visit1.jsonl', 'utf8'));
const v2 = parseScan(readFileSync('scans/visit2.jsonl', 'utf8'));
const OLD = [0.3, -2.8, 1.3, -2.2]; // x0, z0, x1, z1
const NEW = [-1.5, -3.4, -0.9, -2.8];

function stats(frames, travOpts = {}) {
  const g = buildGrid(frames);
  const t = traversability(g, travOpts);
  const box = ([x0, z0, x1, z1]) => {
    let n = 0, occ = 0, walk = 0, pass = 0;
    for (let x = x0 + 0.1; x < x1 - 0.05; x += 0.05) {
      for (let z = z0 + 0.1; z < z1 - 0.05; z += 0.05) {
        const i = Math.floor((z - g.minZ) / g.cell) * g.w + Math.floor((x - g.minX) / g.cell);
        n++;
        if (t.occ[i]) occ++;
        if (t.tier[i] === TRAV.WALKED) walk++;
        if (t.tier[i] !== TRAV.BLOCKED) pass++;
      }
    }
    return { occ: +(occ / n).toFixed(2), walked: +(walk / n).toFixed(2), passable: +(pass / n).toFixed(2) };
  };
  return { old: box(OLD), new: box(NEW) };
}

const only1 = stats(v1.frames);
const both = stats([...v1.frames, ...v2.frames]);
const noRecency = stats([...v1.frames, ...v2.frames], { recencySlack: Infinity });
console.log('visit1 only          ', JSON.stringify(only1));
console.log('both, newest wins    ', JSON.stringify(both));
console.log('both, no recency     ', JSON.stringify(noRecency));

const ok =
  only1.old.occ > 0.3 && // the original table is an obstacle
  only1.new.walked > 0.3 && // visit1 walked through where the table will go
  noRecency.new.passable > 0.5 && // the old behaviour: moved table on the walked path stays passable (the bug)
  both.new.passable < 0.2 && // newest wins: the moved table blocks the walked path
  both.old.occ < only1.old.occ * 0.5; // and the table's old spot is mostly freed
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
