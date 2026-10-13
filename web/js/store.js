// IndexedDB persistence for the cumulative inventory.
//   photos: {id, name, created, width, height, blob}
//   parts:  {id (= packageId), photoId, corners, format, part, ocr, overrides, created, updated}

const DB_NAME = "eci-inventory";
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos", { keyPath: "id" });
      if (!db.objectStoreNames.contains("parts")) {
        const s = db.createObjectStore("parts", { keyPath: "id" });
        s.createIndex("photoId", "photoId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const req2p = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function getAllParts() {
  return tx(["parts"], "readonly", (t) => req2p(t.objectStore("parts").getAll()));
}

export async function getPhoto(id) {
  return tx(["photos"], "readonly", (t) => req2p(t.objectStore("photos").get(id)));
}

export async function getAllPhotosMeta() {
  const all = await tx(["photos"], "readonly", (t) => req2p(t.objectStore("photos").getAll()));
  return all.map(({ blob, ...meta }) => meta);
}

/** Save a photo and its parts. Returns {added, updated}. */
export async function savePhotoWithParts(photo, parts) {
  const existing = new Set((await getAllParts()).map((p) => p.id));
  let added = 0, updated = 0;
  await tx(["photos", "parts"], "readwrite", (t) => {
    t.objectStore("photos").put(photo);
    const ps = t.objectStore("parts");
    const now = Date.now();
    for (const p of parts) {
      if (existing.has(p.id)) updated++; else added++;
      ps.put({ ...p, photoId: photo.id, created: p.created || now, updated: now });
    }
  });
  return { added, updated };
}

export async function putPart(part) {
  return tx(["parts"], "readwrite", (t) => { t.objectStore("parts").put({ ...part, updated: Date.now() }); });
}

export async function deletePart(id) {
  const part = await tx(["parts"], "readonly", (t) => req2p(t.objectStore("parts").get(id)));
  await tx(["parts"], "readwrite", (t) => { t.objectStore("parts").delete(id); });
  // Drop the photo if no part references it any more.
  if (part) {
    const left = (await getAllParts()).some((p) => p.photoId === part.photoId);
    if (!left) await tx(["photos"], "readwrite", (t) => { t.objectStore("photos").delete(part.photoId); });
  }
}

export async function clearAll() {
  return tx(["photos", "parts"], "readwrite", (t) => {
    t.objectStore("photos").clear();
    t.objectStore("parts").clear();
  });
}

// ---------------------------------------------------------------- backup
const blobToDataUrl = (blob) => new Promise((resolve) => {
  const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob);
});

export async function exportBackup() {
  const photos = await tx(["photos"], "readonly", (t) => req2p(t.objectStore("photos").getAll()));
  const parts = await getAllParts();
  const out = { app: "electrical-component-inventory", version: 1, exported: new Date().toISOString(), photos: [], parts };
  for (const p of photos) out.photos.push({ ...p, blob: p.blob ? await blobToDataUrl(p.blob) : null });
  return new Blob([JSON.stringify(out)], { type: "application/json" });
}

export async function importBackup(file) {
  const data = JSON.parse(await file.text());
  if (data.app !== "electrical-component-inventory") throw new Error("Not an inventory backup file");
  const photos = await Promise.all(data.photos.map(async (p) => ({
    ...p, blob: p.blob ? await (await fetch(p.blob)).blob() : null,
  })));
  await tx(["photos", "parts"], "readwrite", (t) => {
    for (const p of photos) t.objectStore("photos").put(p);
    for (const p of data.parts) t.objectStore("parts").put(p);
  });
  return { photos: photos.length, parts: data.parts.length };
}
