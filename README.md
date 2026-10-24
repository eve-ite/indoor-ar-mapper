# Indoor AR Mapper

Open-source, Android-first indoor mapper. A phone (handheld or riding a small robot car) scans a space with WebXR into a 2D occupancy grid; later, anyone can get AR arrows to navigate room to room.

Status: **M1 (scan app) + M2 (map viewer)** built. Car (M3/M4) and navigation (M5) are next.

## Run it

```sh
# 1. server (laptop) — needs uv
cd server
uv run uvicorn main:app --port 8000

# 2. public HTTPS for the phone (separate terminal)
cloudflared tunnel --url http://localhost:8000 --protocol http2 --no-autoupdate
```

cloudflared prints a `https://<random>.trycloudflare.com` URL (new one every restart).

- Phone (Chrome on Android): `<tunnel>/scan/`
- Laptop: `http://localhost:8000/viewer/` (works with no internet at all)

## Networking (hackathon wifi, no hotspots)

- **No hotspots / SoftAPs anywhere**, including the ESP32 later. Don't assume the phone can reach the laptop's LAN IP either: venue wifi usually isolates clients.
- **cloudflared quick tunnel** only dials *out*, so it works on venue wifi. `--protocol http2` keeps it on TCP 443; the default QUIC uses UDP 7844, which venues often block.
- **Offline-first scanning:** once `/scan/` has loaded, recording never touches the network. Frames are mirrored to IndexedDB every ~2 s, so a crashed tab can be recovered from the "Saved on this phone" list. Upload is separate and retryable.
- **Tunnel dead?** Tap ⬇ / Download on the phone, copy the `.jsonl` over USB, and drag it into the viewer at `localhost:8000/viewer/`. Parsing happens in the browser.
- **Pages hosted elsewhere later** (GitHub/Cloudflare Pages): add `?server=https://your-server` to `/scan/` or `/viewer/`. The server already sends CORS headers.
- **M3 plan:** the ESP32 joins venue wifi as a normal client and dials **out** to `wss://<tunnel>/...`. Backup if venue wifi is WPA2-Enterprise or captive-portal: Web Bluetooth from the laptop browser straight to the ESP32 (no wifi at all).

## Scanning tips

- Stand on the **start marker** (taped X), facing the agreed direction, then tap Start. The `local-floor` origin is wherever the session starts, so this is what makes scans line up with each other and with navigation.
- The fake lidar is a fan of 28 hit-test rays (7 yaws over ±35° × pitch 0°/−10°/−20°/−30°, `FAN_*` in `web/scan/scan.js`). Multiple rows matter: a level ray at hand height flies over tables, so the downward rows are what sweep across table tops. Chrome's hit test (as far as we know) hits only **ARCore-detected planes**, and ARCore needs **parallax** to find them: move slowly with some sideways motion. Pure rotation finds nothing new.
- Side walls get picked up well when moving forward; the wall straight ahead less so. Blank walls give few hits: keep lights on, add posters/tape.
- The status line shows **per-ray hit %**. Use it on the S23 to see which rays earn their keep.
- **On the car (M4):** mount the phone **offset from the turning axis** (e.g. front of the deck) so turns include translation. Drive slowly, in arcs rather than spins.

## Viewer

- **Map** mode (default) is a 3D view (three.js, `viewer/view3d.js`): obstacles as 10 cm blocks extruded to the height the scan saw (neighbourhood-median smoothed; holes filled, specks under 2.5 dm² hidden), floor plane with walked paths tinted, route as a tube between marker posts. Drag to orbit, right-drag/two fingers to pan, scroll/pinch to zoom, ⊙ for top-down; click the floor twice for a route. **Debug** mode is the 2D grid/points/sliders view. `?mode=map|debug`.
- Pick a scan from the server list, or drop a file. `?scan=<id>` loads one directly.
- Grid: 5 cm cells, log-odds. Trajectory cells are free; Bresenham from the phone to each hit frees the cells in between. A hit below *floor* marks free, a hit inside the *wall band* marks occupied, anything else is ignored.
- **Ray clears below:** a ray only clears a cell where it passes below this height. A ray passing higher proves nothing about what's under it, so a handheld ray at 1.4 m doesn't erase the table it flies over.
- **Heights are above the tracked floor** (`common/floor.js`), not local-floor's y=0, which drifts and can start out wrong.

### Traversability (what navigation uses)

`common/trav.js`, shown with the *Traversability* layer. Three tiers, by trust:

| Tier | From | A* |
|---|---|---|
| walked | trajectory widened by body radius: something physically passed | cost 1, never vetoed |
| floor seen | free evidence from floor hits | cost 4 |
| blocked | obstacles (inflated by body radius) and unknown cells | impassable |

So a cluttered hallway you walked through stays a hallway, and routes stick to proven paths. Click the map twice (or `?route=ax,az,bx,bz`) to test a route.

**Profiles:** *Person* (obstacles 0.2–2 m, radius 0.25 m) or *RC car* (obstacles 0.07–0.45 m, radius 0.15 m; floor under tables counts as passable). Auto-detected from the phone's median height above the floor (< 0.7 m means car).

### Depth lidar (optional)

**Opt-in: tick "Depth lidar" under Settings on the scan page** (remembered per phone; `?depth=1` / `?depth=0` override). Off by default until it has been tried on more phones (iOS especially). The scan app then requests WebXR `depth-sensing` (CPU path only) as an optional feature, samples it at 5 Hz, shows ms per sample, and pauses sampling if it averages over 25 ms. If Chrome grants it, each frame also samples the depth map on a 16 × 5 grid (`common/depth.js`) and stores world points as `dpts`. Depth sees *any* surface, including clutter that ARCore never turns into planes. If it's refused, the session starts without it and the plane fan works as before. The status line says `depth ON` or `depth off`. Depth samples get an extra 8 cm height margin, because they're noisier than plane hits.
- Drag to pan, wheel to zoom, double-click to fit. −Z (the start-marker forward direction) is up.

## Data format (JSON Lines)

One JSON object per line, so a crash only loses the last line. Meters, WebXR `local-floor`, **Y up** (floor map is X/Z), quaternions `[x,y,z,w]`, `t` = seconds since session start.

```json
{"type":"header","session_id":"abc123","device":"SM-S911B","ref_space":"local-floor","start_marker":{"p":[0,0,0],"q":[0,0,0,1]},"created":"2026-10-24T10:00:00Z","app_version":"0.1","fan":{"rays":[[-35,0],...],"origin":"viewer"}}
{"type":"frame","t":12.34,"p":[0.12,1.40,-1.40],"q":[0,0.38,0,0.92],"tracking":"normal","pts":[[1.2,0.0,-2.1],[1.3,0.9,-2.2]]}
{"type":"stats","frames":420,"points":3100,"ray_tries":5880,"ray_hits":[...],"duration":42.1}
```

Frames may also carry `dpts` (depth-map samples, same units). The header then has a `depth` object with the usage, format and sampling grid. `pts` are plane hits, which share exact heights per plane; the floor tracker uses only those.

`tracking` is `normal` or `limited` (emulated position). Lost-tracking frames aren't recorded. Frames are recorded at 10 Hz. `stats` is written on Stop, so a scan missing it was interrupted.

## Layout

```
server/main.py          FastAPI: POST/GET /api/scans, serves web/
web/scan/               phone scan app (WebXR + three.js, IndexedDB mirror)
web/viewer/             laptop map viewer (canvas) + grid.js
web/common/jsonl.js     shared tolerant parser
web/vendor/             three.js r170 (vendored so the phone needs no CDN)
tools/make_synthetic.py synthetic 4×5 m room scan (--depth adds depth samples)
scans/                  uploads (gitignored)
```

Test without a phone:

```sh
server/.venv/Scripts/python tools/make_synthetic.py scans/synthetic.jsonl   # then open /viewer/?scan=synthetic
```

## Scan chaining (branch `scan-chaining`)

Short scans that continue each other, so one long walk becomes several crash-proof pieces.

1. **End a scan:** stop, put a small mark (tape/coin) on the floor under the phone, and note which
   way you're facing (e.g. along a tile seam).
2. **Next scan:** hold the phone over that mark, facing the same way, and tap **Continue from …**.
   The header records `continues` (the previous session), `continues_end` (its last pose) and
   `chain` (the first scan's id). The last pose is saved every ~2 s, so even a crashed scan can be
   continued.
3. **Viewer:** load any scan in the chain, then tick **combine chain into one map**. Each scan is
   placed by matching its first pose to the previous scan's last pose (`web/common/chain.js`).
   - **Nudge sliders** (turn / x / z, per link, remembered) fix a sloppy handover by eye: line up
     doubled walls. A nudge can also be saved in the scan file itself as `continues_nudge`
     ({yawDeg, dx, dz}); browser slider tweaks override it.
   - **Auto-align (experimental)** matches obstacles between the scans. It's conservative: it
     never moved a good placement in tests, but along long plain walls the overlap is ambiguous,
     so it only partly fixes a sloppy one.

Tests: `node tools/test_chain.mjs` (split a synthetic scan, re-place it with a 4°/15 cm handover
error). Demo chain: `node tools/make_chain.mjs scans/synthetic_depth.jsonl scans/chain --err 4,0.15,-0.1`,
then open `/viewer/?scan=chain_b&combine=1`.

## Room labels, newest-scan-wins, floor plan (branch `scan-chaining`)

- **Labels while scanning:** stand at the place (e.g. in the doorway), type the room name in the
  box under Stop, and tap **Label here**. Recorded as `{"type":"label","t","name","p":[x,floorY,z]}`
  at the phone's spot. Chained scans carry their labels into the combined map.
- **Labels in the viewer:** the Rooms panel has **+ Add label** (click a spot, name it) and ✕ to
  remove. They're saved to `scans/<id>_labels.json` (`GET/PUT /api/scans/{id}/labels`), in that
  scan's coordinates, or the chain root's when combined. **Route here** routes from point A, or from
  the start marker if no A is set.
- **Newest wins** (`grid.js` keeps per-cell `obsT` / `clearT` / `walkedT`; `trav.js` decides):
  - an obstacle is dropped when a ray passes through at the height it was seen, more than
    `recencySlack` (15 s) later. Rays passing *under* a table don't count.
  - an obstacle seen more than 15 s after you walked a spot blocks that walked corridor (e.g. a
    table moved onto it).
  - evidence from the same pass is never treated as a change.
  - Test: `node tools/test_moved.mjs` (two synthetic visits, the table moved onto the first visit's
    path).
- **Floor plan** (Map view → View): structure only (`common/plan.js`). A wall is anything seen above
  1 m, or a long thin run (≥ 2 m, mostly empty bounding box). It's drawn at a uniform 1.2 m on a
  plain floor. **Display only:** routing still avoids furniture. From car height everything is low,
  so only the long-thin rule applies there.

## Not built yet: live re-routing during navigation (for the M5 nav app)

Furniture moves after scanning. The nav app should notice obstacles on the route and re-plan,
**without slowing the walker or taxing the phone**:
- **Keep the AR frame loop light:** don't block rendering for sensing. People may walk fast; arrows
  must stay smooth at 30–60 fps.
- **Sense sparsely:** depth (if available) at **2 Hz** on a **small grid** (e.g. 8 × 3 samples, the
  lower-middle of the view), or 3–5 hit-test rays straight ahead. Skip a sample when the previous one
  is still being processed. Pause sensing entirely when the phone is pointed at the floor or sky.
- **Only look ahead:** check only samples within ~4 m of the phone **and** within ~0.6 m of the
  remaining route. Ignore everything else.
- **Re-plan rarely and locally:** mark new obstacle cells in a small overlay (not a full grid
  rebuild). Re-run A* only when the overlay intersects the next ~5 m of the route, at most **once
  per second**, and on a window around the phone (cheap), then rejoin the global path.
- **Forget:** overlay obstacles expire after ~60 s unless seen again (people walk past).
- **Fail soft:** if sensing isn't available (no depth, few hits), just follow the precomputed
  route. The map's newest-wins data plus the car's ultrasonic stop are the backstops.

## Wide hallways, speed, real vs simulated (branch `scan-chaining`)

- **Wide hallways:** the camera only sees about ±30° to each side, so walls beside you never enter
  the picture while you walk straight.
  - Depth now reaches **8 m** (was 5 m; ARCore's practical limit), with a sample row just above
    the image centre. The grid keeps hits up to 9 m.
  - The scan hint asks **"Glance left ↶" / "Glance right ↷"** when you're walking and nothing
    has been seen on one side for 6 s.
  - Synthetic test (walk straight down the middle; side walls mapped):

    | Width | Old app | New 8 m range | + glancing |
    |---|---|---|---|
    | 6 m | 0% | 75% | 91% |
    | 8 m | 0% | 0% | 89% |

    Reproduce: `python tools/make_synthetic.py scans/hall.jsonl --depth --room -4,-20,4,1 --path hall --sway 0.7 --depth-max 8 --rows-up`.
- **Viewer speed:** `close()` (mask clean-up) is now two chamfer passes instead of a disk loop: on
  a 5 M-cell venue grid ~0.3 s instead of up to 2.6 s, with identical output
  (`node tools/test_close.mjs`).
  - The 3D view keeps the normal and floor-plan versions built (the other one is pre-built while
    idle), so the floor-plan toggle is ~1 ms.
  - 2D debug images are only built in Debug mode.
  - The camera's clipping range is sized to the map, which fixes tilted big maps being cut off at
    the far end.
- **Real vs simulated:** the server marks scans with device `synthetic` (or `"simulated": true`,
  which the generator now writes) as simulated. The viewer shows **REAL · device** or
  **SIMULATED** badges in the scan list, and a chip on the map.
