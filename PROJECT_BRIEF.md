# Indoor AR Mapper (CalHacks solo hack): Project Brief

*Last updated 2026-10-24. This is the current state, not the original plan. Read it fully
before starting; then read the README of the area you're working in.*

## Pitch
Open-source, Android-first indoor mapper. Open a website on your phone, then hold it or mount it
on a small robot car; it scans the space into a map. Later, anyone can open the site and get AR
arrows to navigate room to room.

## Hard constraints
- Solo, hackathon timeline (ends Sunday). Working > polished.
- **Web only, no native app.** Target: Chrome on Android, WebXR `immersive-ar` (ARCore).
  Dev phone: Samsung Galaxy S23.
- **HTTPS required** for WebXR/sensors (cloudflared tunnel; see Networking).
- **MVP must not depend on Chrome flags** (judges' phones won't have them). Everything optional
  sits behind feature detection.
- **No hotspots of any kind at the venue** (phone hotspots, ESP32 SoftAP). Hackathon wifi has
  client isolation, so don't assume LAN reachability between devices.
- Hackathon wifi is unreliable: **record locally on the phone first, upload after.**
- iPhone Safari lacks WebXR AR: iPhones get a fallback mode (still TBD).

## Repo and layout
Repo: `C:\Users\derpf\Documents\indoor-ar-mapper` (git, branch `master`; no remote).

```
server/main.py          FastAPI: POST/GET /api/scans, serves web/; includes car_relay
server/car_relay.py     /car + /drive WebSocket relay, /teleop static mount  (branch car-m3)
web/scan/               M1 phone scan app (WebXR, hit-test fan, optional depth, IndexedDB)
web/viewer/             M2 viewer: Map = 3D blocks (view3d.js), Debug = 2D grid/points
web/common/             shared: jsonl.js, floor.js (floor tracker), grid.js (occupancy +
                        walked corridor), trav.js (traversability, A*, simplifyPath), depth.js
web/vendor/             three.js r170 + OrbitControls (vendored; no CDN at the venue)
car/                    M3 (branch car-m3): firmware/, teleop/, mock_car.py, tests/, tools/,
                        WIRING.md (wiring source of truth), README.md
tools/make_synthetic.py synthetic room scans (--depth adds depth samples) for testing
scans/                  uploaded scans (gitignored)

branch textures-exploration (worktree .claude/worktrees/textures-exploration):
TEXTURES_FINDINGS.md    research, budgets, nerfstudio mapping, Phase 3 status
web/camtest/            standalone camera-access test page (offline after one visit)
web/common/keyframes.js camera grab, intrinsics/pose/projection math, capture gate
web/viewer/floorcolor.js floor coloured from photos (projection + occlusion)
```

## Status
| Milestone | State |
|---|---|
| **M1** handheld scan | **Done, tested on the S23.** 28-ray hit-test fan (7 yaws × pitch 0/−10/−20/−30°), live hints (tilt, speed, side-to-side), IndexedDB crash recovery, download/upload. Optional **depth lidar** toggle (Settings) works on the S23 without flags. |
| **M2** viewer | **Done.** Map mode is a 3D view: obstacles are blocks extruded to the scanned height, the floor is a plane with walked paths tinted, and click twice to plan an A* route. Debug mode is the 2D grid/points with tuning sliders. Person/RC-car profile auto-detected from the phone height. |
| **M3** car drives | **Software done on branch `car-m3`, not merged.** **Bluetooth LE is the primary link and is verified on the real board** (no motors wired yet): 20 Hz commands, 10 Hz telemetry, deadman stops 301 ms after the last command. A page disconnect is also caught by the deadman, because Windows holds the BLE link ~3 s. Teleop has a Connect Bluetooth button (Chrome/Edge). WiFi mode remains behind `CONTROL_LINK`. Mock + automated tests pass. **Gotcha:** init BLE from `setup()`, not the core-0 task, or the UART service is missing. |
| **M4** car scan | Not started (needs the built car). |
| **M5** navigation | Not started. A*, path smoothing and traversability already exist in `web/common/trav.js`, so it's mostly the AR side. |
| **Textures** (bonus) | **Built on branch `textures-exploration`, not merged, not yet run on the S23.** Camera photos during scans (opt-in), photo frustums + photo-coloured floor in the viewer, nerfstudio export. Verified on synthetic scans only. See Textures below. |

## Key decisions so far (don't undo these without asking)
- **Networking:** cloudflared quick tunnel with `--protocol http2` (TCP 443; venues often block
  UDP/QUIC). Tunnel URLs change on every restart, so pages use relative URLs (`?server=`
  overrides).
- **Car link:** **Bluetooth LE is primary.** The ESP32 acts as a Nordic UART Service-style peripheral,
  and the teleop page talks to it directly with Web Bluetooth (no server needed to drive).
  WiFi/WebSocket (`wss://<tunnel>/car`) stays as an optional mode behind a firmware config flag.
- **Depth lidar stays opt-in** (off by default) until it's been tested on iOS. Don't flip the default.
- **Heights are relative to a tracked floor** (`common/floor.js`), never local-floor's y=0, which
  drifts and can start out wrong.
- **Chrome hit-test only hits ARCore planes** (floor reliably, walls sometimes, clutter never).
  Depth sees everything. ARCore also reports phantom floor planes in the first seconds; the floor
  tracker re-locks on a persistent height change.
- **Keep the three.js depth patch in `scan.js`.** three r170 calls the *GPU* depth API every frame
  when `depth-sensing` is on; on our CPU-depth session that throws and freezes the frame loop. The
  patch makes `XRWebGLBinding.getDepthInformation` return null instead.
- **Don't bump main's IndexedDB version** (`indoor-ar-mapper`): an older page can't open a newer
  DB. New storage goes in a separate database (the textures branch uses `indoor-ar-mapper-keyframes`).
- **Navigation uses traversability, not walls.** There are three tiers: walked corridor (proven, cheapest),
  floor seen (allowed, cost 4), obstacles/unknown (blocked). A cluttered hallway you walked
  through stays passable.
- **Car safety lives on the car:** a 300 ms deadman (stop + coils off), stop on link loss, and forward
  refused under 15 cm with 3 cm hysteresis (without it the car creeps forward). Reverse and turn are always
  allowed.

## Data format: JSON Lines (one object per line; a crash only loses the last line)
Meters, WebXR `local-floor`, **Y up** (map in X/Z), quaternions `[x,y,z,w]`, `t` = seconds
since session start.
```json
{"type":"header","session_id":"abc123","device":"S23","ref_space":"local-floor","start_marker":{"p":[0,0,0],"q":[0,0,0,1]},"created":"…","app_version":"0.1","fan":{"rays":[[yaw,pitch],…],"origin":"viewer"},"depth":null}
{"type":"frame","t":12.34,"p":[…],"q":[…],"tracking":"normal","pts":[[x,y,z],…],"dpts":[[x,y,z],…]}
{"type":"stats","frames":…,"points":…,"ray_tries":…,"ray_hits":[…],"depth_frames":…,"duration":…}
```
- `pts` = plane hits (exact heights per plane), `dpts` = depth samples (only when depth was on).
- Missing `stats` = interrupted scan. Parsers must skip unknown types and a truncated last line.
- Textures branch only: `{"type":"keyframe","t","p","q","intrinsics":{"fx","fy","cx","cy","w","h"},"img":"kf_0042.jpg"}`.
  Intrinsics are in pixels with a top-left origin; p/q is the camera pose (`view.transform`). Photos
  live in `scans/<id>_kf/`. Lines may arrive out of `t` order (written once the photo is stored).

## Textures (branch `textures-exploration`)
- **Findings** (`TEXTURES_FINDINGS.md`): WebXR raw camera access (`camera-access`) has been in Chrome
  since 107, so it should be flag-free, but it's **unverified on the S23**. getUserMedia during AR is not a
  path. Budget ~6–15 MB of 960 px JPEGs per room. Upload one PUT per photo, so it resumes.
- **`/camtest/`**: pass/fail checklist, capture keyframe with a red-dot projection check,
  getUserMedia probe. **It works offline after one visit** (service worker): results are saved on the
  phone and shared via the share sheet (e.g. to Google Drive).
- **Scan app**: Settings → "Camera photos" (or `?keyframes=1`), off by default. Capture is gated at
  30 cm / 15° / 0.5 s and skipped while turning >40°/s. `renderer.resetState()` runs after every raw-GL grab.
- **Viewer**: a Photos panel (shown only when a scan has photos) with camera frustums + thumbnails,
  "colour the floor from photos", and an export link: `GET /api/scans/{id}/nerfstudio.zip`.
- **Verified on synthetic data** (`make_synthetic.py --photos`): the Python render and the JS
  projection agree to 0.002 px, floor tiles and the rug landmark land correctly, and the export
  pose/pitch are correct.
- **Pending, needs the phone:** whether `camera-access` is granted, whether readback comes out upside
  down, grab ms, and three.js coexisting with the raw GL. **Next step:** in a short server window, open
  `<tunnel>/camtest/` once so it caches, then test asynchronously.

## Car (M3)
- **Board:** YD-ESP32-23 (ESP32-S3 N16R8, a DevKitC-1 clone), on the laptop's **COM11** (CH343 UART
  port). arduino-cli (bundled with Arduino IDE 2) + esp32 core 3.3.12. FQBN:
  `esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi,PartitionScheme=app3M_fat9M_16MB`.
- **Hardware:** 2× 28BYJ-48 + ULN2003 (steppers), HC-SR04 (echo via 1k/2k divider), IR module,
  MPU6050. **`car/WIRING.md` is the wiring source of truth**; `car/firmware/car/config.h`
  mirrors it. Don't change pins.
- **Power:** ESP32 on its own USB from the power bank; ULN2003s + HC-SR04 on a separate 5 V
  rail with a 470 µF capacitor; mandatory GND wire between them.
- **Protocol** (same JSON over BLE and WebSocket): drive
  `{"type":"drive","v":-1..1,"w":-1..1,"seq":n}` (v forward +, w turn left +) and telemetry
  `{"type":"telemetry","dist_cm","ir_blocked","left_steps","right_steps","yaw_rate","rssi","uptime_ms","blocked","seq"}`.
  Over BLE, every message is a `\n`-terminated line, split into MTU-sized pieces.
- **Speed:** ~4.5 cm/s at the default `MAX_STEP_RATE 900`. The 28BYJ-48 skips steps above ~1000 half-steps/s.

## Run and test
```sh
cd server && uv run uvicorn main:app --port 8000                       # server
cloudflared tunnel --url http://localhost:8000 --protocol http2 --no-autoupdate   # phone HTTPS
```
| Page | URL |
|---|---|
| Phone scan app | `<tunnel>/scan/` |
| Viewer | `http://localhost:8000/viewer/` (`?scan=<id>&mode=map\|debug&route=ax,az,bx,bz`) |
| Teleop | `http://localhost:8000/teleop/` |
| BLE echo test | `/teleop/ble-test.html` |

Tests (no hardware needed):
- `server/.venv/Scripts/python car/tests/test_car.py`
- `node car/tests/teleop_e2e.mjs`
- `python tools/make_synthetic.py scans/synthetic_depth.jsonl --depth`, then view it
- Textures branch: `python tools/make_synthetic.py scans/synthetic_photos.jsonl --photos`, then open
  the viewer with `?scan=synthetic_photos` and tick "colour the floor from photos". Server endpoints are
  tested in-process (`uv run --no-project --with fastapi --with httpx2 python …` + `TestClient`).
  Phone page: `<tunnel>/camtest/`.

Dev tools:
- `uv run --with pyserial car/tools/serial_tail.py COM11 --seconds 5`
- `uv run --with bleak car/tools/ble_probe.py echo|drive`

## Working in parallel (rules for agents)
- **Use your own git worktree + branch** (e.g. `git worktree add .claude/worktrees/<name> -b <name>`).
  Never edit the main checkout. Never use bare `git stash` (the stash is shared).
- **Stay in your area.** Don't change the behavior of other components; add new files instead of
  refactoring shared ones. **Ask before refactoring existing code.**
  - `server/main.py`: add routes only, via a separate module plus one include line.
  - `web/common/*`: shared by the viewer, scan app and (later) nav. Changes need the existing
    tests and screenshots to still pass.
- **Hardware is single-user:** only one agent may use COM11 / flash the board at a time. Say so before
  you flash.
- **Ports:** 8000 is the dev server. Tests use 8790/8791. **Windows reserves port 8765**, don't use it.
- **Memory is tight on this laptop:** don't leave servers, tunnels or headless browsers running
  when you're done. Claude Code kills idle background servers under memory pressure. When the user
  needs the server for the phone, give them the commands to run in their own terminal.
- **Worktree checkouts use CRLF line endings:** normalize before doing multi-line string edits in
  scripts (git converts on commit, so diffs stay clean).
- **Browser:** the user's default browser is **Brave, which disables Web Bluetooth**. Open BLE
  pages in Chrome/Edge (`chrome.exe <url>`).
- Commit in small steps. End commit messages with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Units are SI internally. Feature-detect anything optional. No Chrome flags in the MVP path.
- Before handing back: run the tests for anything you touched and report pass/fail honestly.

## Backlog (good parallel tasks)
1. **Car BLE primary link**: done on `car-m3`, waiting for the user's Chrome teleop check and the
   merge. Next on the car: wire the motors and sensors (`car/WIRING.md` bring-up order), then M4.
2. **M5 nav app** (`web/nav/`): load a scan, start on the start marker, run A* with
   `common/trav.js` (`astar`, `simplifyPath`), and draw three.js AR arrows along the path. Reuse the
   scan app's WebXR session setup.
3. **iPhone fallback mode:** decide what iPhones get (e.g. 2D map plus route, no AR) and build it.
4. **Judge QR flow:** a landing page, then pick scan / mount on car / navigate.
5. **Merge/align multiple scans** that share the start marker, so they combine into one map in
   the viewer.
6. **Hosting:** static pages on GitHub/Cloudflare Pages plus a hosted API (`?server=` and CORS
   already work).
7. **Car WiFi mode test** on a normal 2.4 GHz network (user will do this off-site).
8. **Chassis:** 3D-print wheels, caster, phone clamp (mount it offset from the turning axis),
   power bank cradle.
9. **Textures phone test + merge decision** (`textures-exploration`): run `/camtest/` and a scan with
   Camera photos on the S23, fix whatever the phone reveals (e.g. a vertical flip), then decide
   whether to merge. The colored top-down floor is the demo piece.

## Open questions
- What does the iPhone fallback do?
- Where do the pages and the API live with public HTTPS for the demo?
- Venue wifi type (WPA2-Enterprise would block the car's WiFi mode; BLE avoids it).
- Depth on by default after iOS testing?
- Is `camera-access` flag-free on the S23, and does the readback need a vertical flip? (`/camtest/`
  answers both.)
