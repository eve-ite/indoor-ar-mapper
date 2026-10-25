// Camera keyframes: grab the WebXR camera image (camera-access), encode JPEGs, and the camera math
// shared by the scan app (capture) and the viewer (frustums, floor colours, export).
//
// Intrinsics convention: pixels with a TOP-LEFT origin (like JPEG / OpenCV), so
//   u = fx * (x / -z) + cx,   v = cy - fy * (y / -z)   for a point (x, y, z) in camera space
// (camera looks down -Z, +Y up: the WebXR / OpenGL convention).

// From a WebXR view projection matrix (column-major) for an image w x h aligned with the view.
// Formulas from the raw-camera-access explainer; cy flipped to a top-left origin.
export function intrinsicsFromProjection(P, w, h) {
  return { fx: (P[0] * w) / 2, fy: (P[5] * h) / 2, cx: ((1 - P[8]) * w) / 2, cy: h - ((1 - P[9]) * h) / 2, w, h };
}

// Camera-to-world 4x4 (column-major) from position p and quaternion q [x, y, z, w].
export function poseMatrix(p, q) {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    p[0], p[1], p[2], 1,
  ];
}

// World point -> camera space for a camera-to-world matrix M (rigid: inverse = transpose of R).
export function worldToCamera(M, [x, y, z]) {
  const dx = x - M[12], dy = y - M[13], dz = z - M[14];
  return [M[0] * dx + M[1] * dy + M[2] * dz, M[4] * dx + M[5] * dy + M[6] * dz, M[8] * dx + M[9] * dy + M[10] * dz];
}

// World point -> [u, v] pixel (top-left origin), or null if behind the camera.
export function projectToImage(M, K, world) {
  const [cx, cy, cz] = worldToCamera(M, world);
  if (cz >= -1e-6) return null;
  return [K.fx * (cx / -cz) + K.cx, K.cy - K.fy * (cy / -cz)];
}

// ---- capture gate: only on real movement, never while the phone is swinging (motion blur) ----
export const GATE = {
  minMove: 0.3, // m since the last keyframe...
  minTurnDeg: 15, // ...or this much rotation
  minInterval: 0.5, // s between keyframes
  maxTurnRateDeg: 40, // deg/s; faster than this = probably blurry, wait
};

const angleBetween = (a, b) => {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
};

export class KeyframeGate {
  constructor(opts = {}) {
    this.o = { ...GATE, ...opts };
    this.last = null; // { t, p, q } of the last keyframe
    this.prev = null; // previous frame, for the turn rate
  }

  // Feed every recorded frame; returns true when this frame should become a keyframe.
  check(t, p, q) {
    const prev = this.prev;
    this.prev = { t, q };
    const rate = prev && t > prev.t ? angleBetween(prev.q, q) / (t - prev.t) : 0;
    if (rate > this.o.maxTurnRateDeg) return false;
    if (!this.last) return true;
    if (t - this.last.t < this.o.minInterval) return false;
    const moved = Math.hypot(p[0] - this.last.p[0], p[1] - this.last.p[1], p[2] - this.last.p[2]);
    return moved >= this.o.minMove || angleBetween(this.last.q, q) >= this.o.minTurnDeg;
  }

  taken(t, p, q) {
    this.last = { t, p, q };
  }
}

// ---- GPU grab: camera texture -> our framebuffer -> readPixels (bottom-up rows) ----
// Leaves GL state changed; a three.js caller must call renderer.resetState() afterwards.
export class CameraGrabber {
  constructor(gl, maxWidth = 960) {
    this.gl = gl;
    this.maxWidth = maxWidth;
    this.fbo = null;
    this.size = [0, 0];
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('camera shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    this.prog = gl.createProgram();
    gl.attachShader(this.prog, sh(gl.VERTEX_SHADER, `#version 300 es
      out vec2 uv;
      void main() {
        vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
        uv = p;
        gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      }`));
    gl.attachShader(this.prog, sh(gl.FRAGMENT_SHADER, `#version 300 es
      precision mediump float;
      in vec2 uv;
      uniform sampler2D cam;
      out vec4 color;
      void main() { color = vec4(texture(cam, uv).rgb, 1.0); }`));
    gl.linkProgram(this.prog);
    if (!gl.getProgramParameter(this.prog, gl.LINK_STATUS)) throw new Error('camera shader link: ' + gl.getProgramInfoLog(this.prog));
    this.camLoc = gl.getUniformLocation(this.prog, 'cam');
  }

  // Must run inside the XR frame callback (the camera texture is only valid there).
  grab(binding, camera) {
    const gl = this.gl;
    const tex = binding.getCameraImage(camera);
    if (!tex) return null;
    const w = Math.min(camera.width, this.maxWidth);
    const h = Math.round((camera.height * w) / camera.width);
    if (!this.fbo || this.size[0] !== w || this.size[1] !== h) {
      if (this.fbo) {
        gl.deleteFramebuffer(this.fbo);
        gl.deleteTexture(this.target);
      }
      this.target = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.target);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      this.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.target, 0);
      this.size = [w, h];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.camLoc, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const err = gl.getError();
    if (err) throw new Error(`camera readback GL error 0x${err.toString(16)}`);
    return { px, w, h };
  }
}

// Bottom-up RGBA rows -> JPEG Blob (top-down).
export async function encodeJpeg(px, w, h, quality = 0.8) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const row = w * 4;
  for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  ctx.putImageData(img, 0, 0);
  return c.convertToBlob ? c.convertToBlob({ type: 'image/jpeg', quality }) : new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
}
