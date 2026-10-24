// Depth "lidar": sample a WebXR CPU depth map on a grid of normalized view coords and turn the
// samples into world points. Pure apart from the XR objects passed in, so it's testable in node.
import { r3 } from './jsonl.js';

// Normalized view coords, (0,0) = top-left. Rows sit in the lower half of the image so they
// sweep from the horizon down to the floor.
export const DEPTH_ROWS = [0.4, 0.5, 0.6, 0.7, 0.8];
export const DEPTH_COLS = 16;
export const DEPTH_MIN = 0.3; // m; closer readings are mostly the user's hand/body
export const DEPTH_MAX = 5; // m; ARCore depth gets unreliable beyond this

// getDepthInMeters gives z-depth along the view's -Z axis, so a sample is unprojected with the
// view's projection matrix P (column-major) and moved to world space by the view transform M.
export function unproject(x, y, d, P, M) {
  const vx = ((2 * x - 1 + P[8]) * d) / P[0];
  const vy = ((1 - 2 * y + P[9]) * d) / P[5];
  const vz = -d;
  return [
    M[0] * vx + M[4] * vy + M[8] * vz + M[12],
    M[1] * vx + M[5] * vy + M[9] * vz + M[13],
    M[2] * vx + M[6] * vy + M[10] * vz + M[14],
  ];
}

// Returns world points [[x,y,z], ...], or null when this frame has no depth.
export function sampleDepth(frame, view) {
  let info;
  try {
    info = frame.getDepthInformation(view);
  } catch {
    return null;
  }
  if (!info) return null;
  const P = view.projectionMatrix;
  const M = view.transform.matrix;
  const out = [];
  for (const y of DEPTH_ROWS) {
    for (let c = 0; c < DEPTH_COLS; c++) {
      const x = 0.05 + (0.9 * c) / (DEPTH_COLS - 1);
      let d;
      try {
        d = info.getDepthInMeters(x, y);
      } catch {
        continue;
      }
      if (!(d > DEPTH_MIN && d < DEPTH_MAX)) continue;
      out.push(unproject(x, y, d, P, M).map(r3));
    }
  }
  return out;
}
