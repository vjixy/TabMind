
// shared/db.js
export const DB_NAME = 'tabmind_v1';
export const STORE = 'items';

let _db;
export async function openDB() {
  if (_db) return _db;
  _db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('by_url', 'url', { unique: false });
        store.createIndex('by_title', 'title', { unique: false });
        store.createIndex('by_tag', 'tags', { unique: false, multiEntry: true });
        store.createIndex('by_savedAt', 'savedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _db;
}

export async function addItem(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve(item);
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).add(item);
  });
}

export async function updateItem(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve(item);
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).put(item);
  });
}

export async function getAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function removeItem(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).delete(id);
  });
}

export function normalizeText(s) {
  return (s || '').toLowerCase();
}

export function lexicalFilter(items, query) {
  const q = normalizeText(query);
  if (!q) return items;
  return items.filter(it => {
    const hay = normalizeText([it.title, it.url, (it.summary?.tldr||''), (it.summary?.keyPoints||''), (it.tags||[]).join(' ')].join(' '));
    return q.split(/\s+/).every(tok => hay.includes(tok));
  });
}
