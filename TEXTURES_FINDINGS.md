# Textures exploration: findings (Phase 1)

Goal: add real-world imagery to our maps using only a website in Chrome for Android (Galaxy S23), with nothing we demo depending on Chrome flags.

**Status legend:** ✅ confirmed by a source · ⚠️ likely but unconfirmed · 🧪 measured by the Phase 2 test page (`/camtest/`) on the S23

---

## 1. WebXR Raw Camera Access (`camera-access`)

### API surface ✅
Request it as a session feature, then read the image inside the frame loop.

```js
const session = await navigator.xr.requestSession('immersive-ar', {
  requiredFeatures: ['local-floor'],
  optionalFeatures: ['camera-access', 'hit-test', 'dom-overlay'],
});
const binding = new XRWebGLBinding(session, gl);
// inside requestAnimationFrame:
for (const view of frame.getViewerPose(refSpace).views) {
  if (!view.camera) continue;                       // null if not granted / not alignable
  const tex = binding.getCameraImage(view.camera);  // WebGLTexture, read-only, owned by the UA
  // view.camera.width / .height = image size in texels
}
```

Spec rules for the texture:
- It is **read-only** and the browser owns it; don't delete it.
- It is only valid **inside the rAF callback of an active frame**. Outside that, the call throws `InvalidStateError`.
- Repeated calls in the same frame return the same contents.
- Its format and color-renderability are an *open spec issue*. **The safe way to get pixels:** draw it with a shader into our own framebuffer, then `readPixels`. That's what the test page does.

### Is it on without flags in current Chrome for Android? ✅/🧪
- The Chromestatus entry for WebXR Raw Camera Access is feature [5759984304390144](https://chromestatus.com/feature/5759984304390144).
- In July 2022 the spec editor said it was still behind a flag, with shipping the next step ([w3c list](https://lists.w3.org/Archives/Public/public-immersive-web/2022Jul/0004.html)).
- [caniuse](https://caniuse.com/wf-webxr-camera) lists Chrome / Edge **107+** as supported. For Android it only shows the current version (156), as supported. A [Meta forum thread](https://communityforums.atmeta.com/discussions/Questions_Discussions/request-webxr-raw-camera-access-camera-access-feature-in-quest-browser/1367463) also says Chrome has had it since r107.
- **Conclusion:** it should work flag-free on an up-to-date S23. The test page's checklist confirms this on the device (the "camera-access granted" and "XRView.camera present" rows).
- Not supported in Safari/iOS (no WebXR AR at all), Firefox, or Quest Browser (per that same Meta thread).

### Resolution, frame rate, cost 🧪
The spec gives **no way to choose** resolution; the platform decides ([TAG review](https://tag-github-bot.w3.org/review/652)). ARCore's GPU camera texture is typically around display/preview resolution, but I couldn't find published numbers for Chrome. The test page reports:
- `camera.width × camera.height`
- AR fps with camera-access enabled
- **readback ms**: the shader copy plus `readPixels` (a synchronous GPU→CPU stall)
- **JPEG encode ms** and **JPEG size**

**Expected cost:**
- The camera texture itself is nearly free; the browser already has it for compositing.
- The cost is the readback. At ~1–2 MP, one `readPixels` is a few to tens of ms, which is fine for a keyframe every second or so, never every frame.
- **If it hitches:** read back at a lower resolution (draw the quad into a smaller framebuffer, e.g. 960 px wide), or use WebGL2 async readback (PBO + `fenceSync`).

### getUserMedia at the same time as `immersive-ar`? ⚠️/🧪
- I found no doc that settles it. W3C Immersive Web discussions treat "camera during an AR session" as an open problem ([IRC 2022-04-22](https://www.w3.org/2022/04/22-immersive-web-irc)).
- ARCore holds the back camera for the whole session, so expect `getUserMedia` to fail (`NotReadableError`) or to disturb tracking.
- The test page has a "Try getUserMedia during AR" button that records exactly what happens. **Don't build on this path either way.** `camera-access` is the intended route.

## 2. Intrinsics and pose per image ✅

**From the [explainer](https://github.com/immersive-web/raw-camera-access/blob/main/explainer.md).** Use the view's projection matrix `p` (column-major) and the image size `w × h`. The image is aligned with the view, so the viewport is the full image:

```
fx = p[0] * w/2          fy = p[5] * h/2
cx = (1 - p[8]) * w/2    cy = (1 - p[9]) * h/2      // cy measured from the BOTTOM (GL convention)
skew = p[4] * w/2        // expect 0
```

- For top-left image rows (JPEG / OpenCV), use `cy_top = h - cy`.
- **This matches our own depth unprojection** in `common/depth.js`, which uses `(2x - 1 + P[8])` and `(1 - 2y + P[9])`.
- **Pose:** `view.transform` in our `local-floor` space. That's camera-to-world, with the camera looking down −Z and +Y up (OpenGL convention). Store `p` and `q` like frames, or the 4×4 `matrix`.
- 🧪 **Check:** the test page projects the current center hit-test point into the captured photo using these formulas. If the red dot lands on the reticle target, the intrinsics, pose and row flip are all right.

## 3. Storage and upload budget

| Item | Estimate |
|---|---|
| Keyframe JPEG, ~1280×720, quality 0.8 | ~120–200 KB (indoor scenes) |
| Same at 960 px wide | ~70–110 KB |
| Metadata line in the JSONL (`t, p, q, intrinsics, img`) | ~200 B |
| Keyframe policy: every 30 cm moved or 15° turned | 10 m aisle ≈ 35–50 keyframes; one room loop ≈ 80–150 |
| **One room** | **~10–30 MB** at 1280 px · **~6–15 MB** at 960 px |

**On the phone:**
- Keep JPEG `Blob`s in IndexedDB next to the existing chunk store, in a new `keyframes` object store keyed by `[session_id, name]`.
- Chrome gives an origin a large share of free disk, so tens of MB is fine. Wrap writes in try/catch and stop capturing (with a message) on `QuotaExceededError`.

**Upload: one keyframe per request, not a zip** (`PUT /api/scans/{id}/kf/{name}`, idempotent).
- On flaky hackathon wifi a 20 MB zip or multipart body fails as one unit and restarts from zero.
- Per-file PUTs resume naturally: the client asks the server which names it already has, then sends the rest.
- The JSONL keeps uploading exactly as today. Keyframes upload after it, in the background, with progress.

## 4. Fallbacks if `camera-access` isn't available
1. **Map without imagery (today's behavior).** The toggle shows "camera access not available", and scanning continues normally.
2. **Photos from the normal camera app plus SfM on the laptop**, for splats only. COLMAP (or nerfstudio's `ns-process-data`) computes its own poses from overlapping photos, so this needs no WebXR at all. Our AR trajectory isn't required. It could help with metric scale or alignment, but that's optional.
3. **Non-AR `getUserMedia` "photo walk".** Video frames with only device-orientation rotation and no position. Weak; not worth building.
4. **iPhone.** No WebXR AR, so only fallback 2 applies.

## 5. Recommendation

1. **Run `/camtest/` on the S23 first** (Phase 2, built). If camera-access is granted, the red dot lands on target, and readback is under ~50 ms, go ahead.
2. **Phase 3, cheapest valuable step:** keyframe capture behind an off-by-default toggle (distance/angle gated), then **thumbnails/frustums at their poses in the 3D viewer**. This is the demo-able "wow" for a few hours of work, and it proves the data is right.
3. **Next: the colored top-down floor.** Project floor pixels onto the 5 cm grid. It reuses the intrinsics plus the plane y = floor, so it's cheap once keyframes exist.
4. **Then `transforms.json` export** for nerfstudio. Mostly a format conversion: our camera-to-world is already OpenGL-convention, which is what nerfstudio's `transforms.json` expects.
5. **Skip textured wall meshes for the hackathon** (see Phase 4 notes below).

## 6. nerfstudio `transforms.json` mapping (for Phase 3)

```json
{
  "camera_model": "OPENCV",
  "fl_x": fx, "fl_y": fy, "cx": cx, "cy": h - cy_bottom, "w": w, "h": h,
  "k1": 0, "k2": 0, "p1": 0, "p2": 0,
  "frames": [{ "file_path": "images/kf_0042.jpg", "transform_matrix": <4x4 camera-to-world, row-major> }]
}
```

- **Camera axes:** nerfstudio uses the OpenGL/Blender camera convention (looking −Z, +Y up), the same as a WebXR view, so the matrix needs no axis flip. It does need converting from WebXR's column-major `Float32Array` to row-major nested lists.
- **World frame:** ours is Y-up. nerfstudio re-orients and centers on load by default, so that's fine.
- **Intrinsics:** these are per-image if they ever change. Write them per frame to be safe; nerfstudio accepts per-frame `fl_x` etc.
- 🧪 Verify with one small capture: `ns-train splatfacto --data <dir>` should converge without camera-pose optimization blowing up.

## 7. Phase 4 notes (no build): textured walls and splats

**Textured walls** (mesh from points plus projected images) would need:
- **Wall geometry.** Fit vertical planes (RANSAC) to the depth points, or extrude the occupancy walls into quads. The current blocks are too lumpy to texture nicely.
- **Per-texel image choice.** Pick the most head-on, closest, least blurry keyframe that can actually see that point, i.e. not hidden behind something else.
- **Seam blending.** Exposure differs between keyframes, so neighboring textures won't match without blending.

**Gaussian splats** would need:
- **Lots of overlap:** 60–80% between neighbors, from varied angles. Our keyframe gating (30 cm / 15°) is about right for handheld; add sideways movement.
- **Sharp images.** Gate capture on low angular velocity using the pose deltas we already have.
- **A laptop GPU** for training. A CalHacks venue laptop may not have one, so this is a stretch goal.

**Pain points:**
- **Low camera (car, ~0.3 m):** sees mostly floor and table legs, and the floor fills most of each image. Fine for the colored floor map, poor for walls and splats. Tilting the phone up on the mount helps walls.
- **Motion blur:** car vibration plus rolling shutter. Capture only while the car is momentarily stopped or slow (deadman pauses are a natural trigger).
- **Blank walls:** few features, so ARCore drifts and SfM/splats struggle. Same mitigation as tracking: texture and light.
- **Drift between keyframes:** misaligned projections, especially on long single passes. Loop back to the start marker.
- **Privacy:** photos may include people at a hackathon. Keep keyframes local by default and make uploading them an explicit choice.

---

### Sources
- [WebXR Raw Camera Access explainer](https://github.com/immersive-web/raw-camera-access/blob/main/explainer.md) · [spec](https://immersive-web.github.io/raw-camera-access/)
- [caniuse: Raw camera access for WebXR](https://caniuse.com/wf-webxr-camera)
- [Spec editor on launch status, Jul 2022](https://lists.w3.org/Archives/Public/public-immersive-web/2022Jul/0004.html)
- [W3C TAG review #652](https://tag-github-bot.w3.org/review/652)
- [Meta forum: camera-access in Chrome vs Quest Browser](https://communityforums.atmeta.com/discussions/Questions_Discussions/request-webxr-raw-camera-access-camera-access-feature-in-quest-browser/1367463)
- [Immersive Web IRC 2022-04-22 (camera during AR sessions)](https://www.w3.org/2022/04/22-immersive-web-irc)
- [WPT camera-access tests](https://chromium.googlesource.com/external/w3c/web-platform-tests.git/+/HEAD/webxr/camera-access)
- [Google: WebXR vs ARCore feature comparison](https://developers.google.com/ar/develop/webxr/arcore-comparison)

---

## Phase 3 status (built on this branch, not yet run on the S23)

Everything is behind toggles that are **off by default**. Scans without photos look and behave exactly as before.

| Piece | Where | Tested |
|---|---|---|
| Keyframe capture: Settings → "Camera photos", or `?keyframes=1`. Requests `camera-access` as optional; gated at 30 cm / 15° / 0.5 s and skipped while turning > 40°/s; 960 px JPEGs in a **separate** IndexedDB (`indoor-ar-mapper-keyframes`), so main's DB version is untouched. A `{"type":"keyframe","t","p","q","intrinsics","img"}` line is written once the photo is stored. | `web/scan/scan.js`, `web/scan/store.js`, `web/common/keyframes.js` | page loads, syntax; **AR path needs the phone** |
| Resumable photo upload (one PUT each, skipping what the server has) and download to the phone (USB fallback) | `scan.js`, server `PUT/GET /api/scans/{id}/kf[/name]` | endpoints ✓ |
| Viewer: camera frustums with photo thumbnails at capture poses | `web/viewer/view3d.js` | synthetic ✓ (screenshot) |
| Viewer: floor coloured from photos (projection + occlusion against obstacle heights) | `web/viewer/floorcolor.js` | synthetic ✓: 58/58 tile colours correct, rug at the right place |
| nerfstudio export (`transforms.json` + images zip) | `GET /api/scans/{id}/nerfstudio.zip` | ✓ det(R)=1, pitch and position match the generator |
| Synthetic scan with ray-cast photos | `tools/make_synthetic.py --photos` | Python render ↔ JS projection agree to 0.002 px |

**Still unknown until the S23 runs `/camtest/` or a scan with photos:** whether the camera image is upside down in readback (the red dot will show it), the real readback ms, and three.js + our raw GL coexisting (`renderer.resetState()` after each grab).
