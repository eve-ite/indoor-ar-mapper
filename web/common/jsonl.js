// Shared JSON Lines helpers. Format spec: see README / PROJECT_BRIEF.
// Units: meters, WebXR local-floor, Y up. Quaternions [x,y,z,w]. t = seconds since session start.

export const APP_VERSION = '0.1';

// Tolerant parse: skips blank and malformed lines (e.g. a truncated last line after a crash).
export function parseScan(text) {
  let header = null;
  const frames = [];
  const labels = []; // room/place names recorded while scanning: { t, name, p: [x, floorY, z] }
  let skipped = 0;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      skipped++;
      continue;
    }
    if (obj.type === 'header' && !header) header = obj;
    else if (obj.type === 'frame' && Array.isArray(obj.p)) frames.push(obj);
    else if (obj.type === 'label' && Array.isArray(obj.p) && obj.name) labels.push(obj);
  }
  return { header, frames, labels, skipped };
}

export function toLine(obj) {
  return JSON.stringify(obj) + '\n';
}

// Round to mm to keep files small; poses don't need more.
export function r3(v) {
  return Math.round(v * 1000) / 1000;
}
