// IndexedDB mirror of the scan so a crashed/closed tab doesn't lose data.
// Every call fails soft: if IDB is unavailable the app keeps working from memory.

const DB_NAME = 'indoor-ar-mapper';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('sessions', { keyPath: 'session_id' });
        const chunks = db.createObjectStore('chunks', { autoIncrement: true });
        chunks.createIndex('session_id', 'session_id');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const result = fn(t);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function soft(fn, fallback) {
  try {
    return await fn(await openDb());
  } catch (err) {
    console.warn('store:', err);
    return fallback;
  }
}

export function startSession(header, text) {
  return soft((db) =>
    tx(db, ['sessions', 'chunks'], 'readwrite', (t) => {
      t.objectStore('sessions').put({
        session_id: header.session_id,
        created: header.created,
        frames: 0,
        done: false,
        uploaded: false,
      });
      t.objectStore('chunks').add({ session_id: header.session_id, text });
    }),
  );
}

export function appendChunk(sessionId, text, frames) {
  return soft((db) =>
    tx(db, ['sessions', 'chunks'], 'readwrite', (t) => {
      t.objectStore('chunks').add({ session_id: sessionId, text });
      const sessions = t.objectStore('sessions');
      const get = sessions.get(sessionId);
      get.onsuccess = () => {
        if (get.result) sessions.put({ ...get.result, frames });
      };
    }),
  );
}

export function updateSession(sessionId, patch) {
  return soft((db) =>
    tx(db, ['sessions'], 'readwrite', (t) => {
      const sessions = t.objectStore('sessions');
      const get = sessions.get(sessionId);
      get.onsuccess = () => {
        if (get.result) sessions.put({ ...get.result, ...patch });
      };
    }),
  );
}

export function listSessions() {
  return soft(
    (db) =>
      new Promise((resolve, reject) => {
        const req = db.transaction('sessions').objectStore('sessions').getAll();
        req.onsuccess = () => resolve(req.result.sort((a, b) => (a.created < b.created ? 1 : -1)));
        req.onerror = () => reject(req.error);
      }),
    [],
  );
}

// Chunks are auto-incremented, so key order == append order.
export function loadText(sessionId) {
  return soft(
    (db) =>
      new Promise((resolve, reject) => {
        const req = db
          .transaction('chunks')
          .objectStore('chunks')
          .index('session_id')
          .getAll(IDBKeyRange.only(sessionId));
        req.onsuccess = () => resolve(req.result.map((c) => c.text).join(''));
        req.onerror = () => reject(req.error);
      }),
    null,
  );
}

export function deleteSession(sessionId) {
  return soft((db) =>
    tx(db, ['sessions', 'chunks'], 'readwrite', (t) => {
      t.objectStore('sessions').delete(sessionId);
      const cur = t.objectStore('chunks').index('session_id').openKeyCursor(IDBKeyRange.only(sessionId));
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) {
          t.objectStore('chunks').delete(c.primaryKey);
          c.continue();
        }
      };
    }),
  );
}

// ---- keyframe photos (textures branch) ----
// A separate database so main's 'indoor-ar-mapper' DB keeps its version: bumping it would make
// main's scan page fail to open it (VersionError) if both ever run on the same origin.
let kfDbPromise = null;

function openKfDb() {
  if (!kfDbPromise) {
    kfDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('indoor-ar-mapper-keyframes', 1);
      req.onupgradeneeded = () => {
        const os = req.result.createObjectStore('keyframes', { keyPath: ['session_id', 'name'] });
        os.createIndex('session_id', 'session_id');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return kfDbPromise;
}

async function softKf(fn, fallback) {
  try {
    return await fn(await openKfDb());
  } catch (err) {
    console.warn('keyframe store:', err);
    return fallback;
  }
}

// Resolves false (instead of throwing) when storage is full, so capture can stop with a message.
export function putKeyframe(sessionId, name, blob) {
  return softKf(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction('keyframes', 'readwrite');
        t.objectStore('keyframes').put({ session_id: sessionId, name, blob });
        t.oncomplete = () => resolve(true);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
    false,
  );
}

export function listKeyframes(sessionId) {
  return softKf(
    (db) =>
      new Promise((resolve, reject) => {
        const req = db.transaction('keyframes').objectStore('keyframes').index('session_id').getAll(IDBKeyRange.only(sessionId));
        req.onsuccess = () => resolve(req.result.sort((a, b) => (a.name < b.name ? -1 : 1)));
        req.onerror = () => reject(req.error);
      }),
    [],
  );
}

export function countKeyframes(sessionId) {
  return softKf(
    (db) =>
      new Promise((resolve, reject) => {
        const req = db.transaction('keyframes').objectStore('keyframes').index('session_id').count(IDBKeyRange.only(sessionId));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
    0,
  );
}

export function deleteKeyframes(sessionId) {
  return softKf(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction('keyframes', 'readwrite');
        const cur = t.objectStore('keyframes').index('session_id').openKeyCursor(IDBKeyRange.only(sessionId));
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) {
            t.objectStore('keyframes').delete(c.primaryKey);
            c.continue();
          }
        };
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      }),
  );
}
