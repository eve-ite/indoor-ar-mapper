"""Generate a synthetic scan JSONL: a 4 x 5 m room with a table, walked in a loop.

Mimics the scan app: local-floor (Y up), phone at ~1.4 m, fan of hit-test rays
(yaw +-35 deg, pitch 0/-10/-20/-30 deg), random hit dropouts and pose noise.

  python tools/make_synthetic.py scans/synthetic.jsonl [--truncate] [--depth]
"""

import json
import math
import random
import sys

ROOM = ((-2.0, 0.0, -4.5), (2.0, 2.5, 0.5))  # min, max corners (x, y, z)
TABLE = ((0.3, 0.0, -2.8), (1.3, 0.75, -2.2))
YAWS = [-35 + 70 * i / 6 for i in range(7)]
PITCHES = [0, -10, -20, -30]
HZ = 10
DROPOUT = 0.35  # textureless walls -> missing hits
NOISE = 0.01
DEPTH_NOISE = 0.02  # relative range noise, roughly ARCore depth-from-motion


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


def depth_samples(o, yaw, rng):
    """Depth-map samples: a 16 x 5 grid over ~60 x 45 deg below the horizon, 2% range noise."""
    out = []
    for p_deg in (-5, -14, -23, -32, -41):
        for i in range(16):
            a = yaw + math.radians(-30 + 60 * i / 15)
            b = math.radians(p_deg)
            d = (-math.sin(a) * math.cos(b), math.sin(b), -math.cos(a) * math.cos(b))
            tt = min(ray_box_exit(o, d, *ROOM), ray_box_enter(o, d, *TABLE))
            if not 0.3 < tt < 5:
                continue
            tt *= 1 + rng.gauss(0, DEPTH_NOISE)
            out.append([round(o[k] + d[k] * tt, 3) for k in range(3)])
    return out


def waypoints():
    # loop around the table, starting at the origin facing -Z
    return [(0, 0), (0, -1.5), (-1.2, -2.5), (-1.2, -3.8), (0.8, -3.8), (1.7, -3.2), (1.7, -1.8), (0.8, -0.5), (0, 0)]


# ---- --photos: ray-cast keyframe images, written next to the JSONL as <stem>_kf/kf_0000.png ----
KF_W, KF_H, KF_F = 240, 180, 200.0  # px; ~62 deg horizontal FOV
KF_PITCH = math.radians(-25)  # phones look down a bit
KF_EVERY = 0.3  # m, like the scan app's gate
RUG = ((-1.5, -1.5), (-0.7, -0.7))  # red rug on the floor (x/z min, max): a known landmark


def quat_yaw_pitch(yaw, pitch):
    """Yaw about +Y, then pitch about the camera's own X. Returns [x, y, z, w]."""
    sy, cy, sp, cp = math.sin(yaw / 2), math.cos(yaw / 2), math.sin(pitch / 2), math.cos(pitch / 2)
    return [cy * sp, cp * sy, -sy * sp, cy * cp]


def rot(q):
    x, y, z, w = q
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ]


def floor_colour(x, z):
    if RUG[0][0] <= x <= RUG[1][0] and RUG[0][1] <= z <= RUG[1][1]:
        return (220, 40, 40)
    ix, iz = math.floor(x / 0.5), math.floor(z / 0.5)  # 50 cm tiles, 4 colours
    return [(235, 220, 170), (170, 200, 235), (190, 230, 180), (230, 190, 220)][(ix % 2) * 2 + (iz % 2)]


def shade(o, d):
    t_room = ray_box_exit(o, d, *ROOM)
    t_table = ray_box_enter(o, d, *TABLE)
    if t_table < t_room:
        return (140, 95, 60)  # table: brown
    hx, hy, hz = (o[k] + d[k] * t_room for k in range(3))
    if hy <= 1e-6:
        return floor_colour(hx, hz)
    if hy >= ROOM[1][1] - 1e-6:
        return (245, 245, 245)  # ceiling
    stripe = int((hx + hz) / 0.25) % 2  # walls: grey stripes
    return (180, 180, 185) if stripe else (150, 150, 158)


def render_png(path, o, q):
    import struct
    import zlib

    R = rot(q)
    cx, cy = KF_W / 2, KF_H / 2
    raw = bytearray()
    for v in range(KF_H):
        raw.append(0)  # PNG filter: none
        for u in range(KF_W):
            dc = ((u + 0.5 - cx) / KF_F, -(v + 0.5 - cy) / KF_F, -1.0)  # top-left pixel origin
            d = [R[i][0] * dc[0] + R[i][1] * dc[1] + R[i][2] * dc[2] for i in range(3)]
            raw.extend(shade(o, d))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", KF_W, KF_H, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "synthetic.jsonl"
    truncate = "--truncate" in sys.argv
    photos = "--photos" in sys.argv
    depth = "--depth" in sys.argv or photos
    if photos:
        import os

        kf_dir = os.path.splitext(out)[0] + "_kf"
        os.makedirs(kf_dir, exist_ok=True)
        last_kf = None
        n_kf = 0
    rng = random.Random(42)
    lines = [
        {
            "type": "header",
            "session_id": "synthetic_photos" if photos else "synthetic_depth" if depth else "synthetic",
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
            frame = {
                "type": "frame",
                "t": round(t, 3),
                "p": [round(px, 3), round(py, 3), round(pz, 3)],
                "q": [round(v, 4) for v in quat_yaw(yaw)],
                "tracking": "normal",
                "pts": pts,
            }
            if depth:
                # Like the real S23: plane hit-test only finds the floor; depth sees everything.
                frame["pts"] = [h for h in pts if h[1] < 0.05]
                frame["dpts"] = depth_samples(o, yaw, rng)
            lines.append(frame)
            if photos and (last_kf is None or math.hypot(px - last_kf[0], pz - last_kf[1]) >= KF_EVERY):
                q = quat_yaw_pitch(yaw, KF_PITCH)
                name = f"kf_{n_kf:04d}.png"
                render_png(os.path.join(kf_dir, name), o, q)
                lines.append({
                    "type": "keyframe",
                    "t": round(t, 3),
                    "p": [round(px, 3), round(py, 3), round(pz, 3)],
                    "q": [round(v, 5) for v in q],
                    "intrinsics": {"fx": KF_F, "fy": KF_F, "cx": KF_W / 2, "cy": KF_H / 2, "w": KF_W, "h": KF_H},
                    "img": name,
                })
                last_kf = (px, pz)
                n_kf += 1
            t += 1 / HZ
    text = "".join(json.dumps(l, separators=(",", ":")) + "\n" for l in lines)
    if truncate:
        text = text[: -len(text.splitlines()[-1]) // 2 - 1]  # chop the last line mid-object
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"wrote {out}: {len(lines) - 1} lines" + (f", {n_kf} photos in {kf_dir}" if photos else ""))


if __name__ == "__main__":
    main()
