"""Generate a synthetic scan JSONL: a 4 x 5 m room with a table, walked in a loop.

Mimics the scan app: local-floor (Y up), phone at ~1.4 m, fan of hit-test rays
(yaw +-35 deg, pitch 0 / -25 deg), random hit dropouts and pose noise.

  python tools/make_synthetic.py scans/synthetic.jsonl [--truncate]
"""

import json
import math
import random
import sys

ROOM = ((-2.0, 0.0, -4.5), (2.0, 2.5, 0.5))  # min, max corners (x, y, z)
TABLE = ((0.3, 0.0, -2.8), (1.3, 0.75, -2.2))
YAWS = [-35 + 70 * i / 6 for i in range(7)]
PITCHES = [0, -25]
HZ = 10
DROPOUT = 0.35  # textureless walls -> missing hits
NOISE = 0.01


def quat_yaw(yaw):
    # rotation about +Y; yaw=0 looks down -Z
    return [0.0, math.sin(yaw / 2), 0.0, math.cos(yaw / 2)]


def ray_box_exit(o, d, lo, hi):
    """Distance to leave an axis-aligned box from inside."""
    t = math.inf
    for a in range(3):
        if d[a] > 1e-9:
            t = min(t, (hi[a] - o[a]) / d[a])
        elif d[a] < -1e-9:
            t = min(t, (lo[a] - o[a]) / d[a])
    return t


def ray_box_enter(o, d, lo, hi):
    """Slab test; distance to enter a box from outside, or inf."""
    tmin, tmax = 0.0, math.inf
    for a in range(3):
        if abs(d[a]) < 1e-9:
            if not lo[a] <= o[a] <= hi[a]:
                return math.inf
            continue
        t1, t2 = (lo[a] - o[a]) / d[a], (hi[a] - o[a]) / d[a]
        tmin, tmax = max(tmin, min(t1, t2)), min(tmax, max(t1, t2))
    return tmin if tmin <= tmax else math.inf


def waypoints():
    # loop around the table, starting at the origin facing -Z
    return [(0, 0), (0, -1.5), (-1.2, -2.5), (-1.2, -3.8), (0.8, -3.8), (1.5, -1.5), (0.8, -0.5), (0, 0)]


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "synthetic.jsonl"
    truncate = "--truncate" in sys.argv
    rng = random.Random(42)
    lines = [
        {
            "type": "header",
            "session_id": "synthetic",
            "device": "synthetic",
            "ref_space": "local-floor",
            "start_marker": {"p": [0, 0, 0], "q": [0, 0, 0, 1]},
            "created": "2026-10-24T10:00:00Z",
            "app_version": "0.1",
            "fan": {"rays": [[y, p] for p in PITCHES for y in YAWS], "origin": "viewer"},
        }
    ]
    t, speed = 0.0, 0.5
    wps = waypoints()
    for (x0, z0), (x1, z1) in zip(wps, wps[1:]):
        seg = math.hypot(x1 - x0, z1 - z0)
        heading = math.atan2(-(x1 - x0), -(z1 - z0))  # yaw so that forward (-Z) points along the segment
        steps = max(1, int(seg / speed * HZ))
        for i in range(steps):
            s = i / steps
            px, pz = x0 + (x1 - x0) * s, z0 + (z1 - z0) * s
            py = 1.4 + 0.02 * math.sin(t * 6)  # walking bob
            yaw = heading + 0.25 * math.sin(t * 0.9)  # looking around a bit
            o = (px, py, pz)
            pts = []
            for p_deg in PITCHES:
                for y_deg in YAWS:
                    if rng.random() < DROPOUT:
                        continue
                    a = yaw + math.radians(y_deg)
                    b = math.radians(p_deg)
                    d = (-math.sin(a) * math.cos(b), math.sin(b), -math.cos(a) * math.cos(b))
                    tt = min(ray_box_exit(o, d, *ROOM), ray_box_enter(o, d, *TABLE))
                    if not math.isfinite(tt):
                        continue
                    h = [round(o[k] + d[k] * tt + rng.gauss(0, NOISE), 3) for k in range(3)]
                    pts.append(h)
            lines.append(
                {
                    "type": "frame",
                    "t": round(t, 3),
                    "p": [round(px, 3), round(py, 3), round(pz, 3)],
                    "q": [round(v, 4) for v in quat_yaw(yaw)],
                    "tracking": "normal",
                    "pts": pts,
                }
            )
            t += 1 / HZ
    text = "".join(json.dumps(l, separators=(",", ":")) + "\n" for l in lines)
    if truncate:
        text = text[: -len(text.splitlines()[-1]) // 2 - 1]  # chop the last line mid-object
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"wrote {out}: {len(lines) - 1} frames")


if __name__ == "__main__":
    main()
