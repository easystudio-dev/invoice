// Where saved documents and the logo live. IndexedDB when the browser has it (room for thousands of documents,
// one record per document), otherwise localStorage. The rest of the app reads synchronously: IndexedDB mode loads
// everything into memory at start, answers reads from there, and writes changes to the database in the background.
// Loaded as a plain script in the browser, require()'d by storage.test.js with a fake IndexedDB.
const storageLib = typeof module === 'object' ? require('./lib.js') : { safeParse, stampChanges, pruneDeleted, editTime };

const DB_NAME = 'invoice-data';
const OPEN_TIMEOUT_MS = 4000;

// env.indexedDB   → the IndexedDB factory, or nothing to use localStorage
// env.ls          → { get(key), set(key, value) → true when stored, remove(key) } over localStorage
// env.onError     → (error) for a background write that failed
// env.now         → () => ms, for tests
function createStorage(env) {
  const { safeParse, stampChanges, pruneDeleted, editTime } = storageLib;
  const { ls, onError } = env;
  const now = env.now || (() => Date.now());
  const LIST_KEY = env.listKey || 'invoice-list';
  const LOGO_KEY = env.logoKey || 'invoice-logo';
  const DELETED_KEY = env.deletedKey || 'invoice-deleted';
  const UNSAFE = ['__proto__', 'constructor', 'prototype'];
  const isList = v => !!v && typeof v === 'object' && !Array.isArray(v);

  const idb = env.indexedDB || null;
  const api = { mode: idb ? 'indexeddb' : 'localstorage', ready: !idb, fallbackReason: '' };
  let db = null;
  let cacheJson = '{}';
  let cacheLogo = null;
  let cacheDeleted = {};
  const persisted = new Map(); // number → JSON of the document as the database holds it
  let pending = null;
  let chain = Promise.resolve();

  const done = tx => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
  const result = req => req.result;

  function openDb() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IndexedDB did not open')), OPEN_TIMEOUT_MS);
      const req = idb.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('docs'); req.result.createObjectStore('meta'); };
      req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
      req.onerror = () => { clearTimeout(timer); reject(req.error); };
      req.onblocked = () => { clearTimeout(timer); reject(new Error('IndexedDB is blocked')); };
    });
  }

  // Something is wrong with IndexedDB (private window, blocked, full): carry on from localStorage.
  function fallBack(error) {
    try { if (db) db.close(); } catch { /* already closed */ }
    db = null;
    api.mode = 'localstorage';
    api.ready = true;
    api.fallbackReason = (error && error.message) || String(error);
  }

  // Resolves with { list, logo } once reads work. Never rejects: a database that won't open means localStorage.
  api.load = async () => {
    if (api.mode === 'localstorage') return { list: safeParse(ls.get(LIST_KEY), {}), logo: ls.get(LOGO_KEY), deleted: api.getDeleted() };
    try {
      db = await openDb();
      let tx = db.transaction(['docs', 'meta'], 'readonly');
      const keysReq = tx.objectStore('docs').getAllKeys();
      const valsReq = tx.objectStore('docs').getAll();
      const logoReq = tx.objectStore('meta').get('logo');
      const migratedReq = tx.objectStore('meta').get('migrated');
      const deletedReq = tx.objectStore('meta').get('deleted');
      await done(tx);
      let list = {};
      result(keysReq).forEach((k, i) => {
        const doc = result(valsReq)[i];
        if (typeof k === 'string' && !UNSAFE.includes(k) && isList(doc)) list[k] = doc;
      });
      let logo = result(logoReq) ?? null;

      if (!result(migratedReq)) {
        // First visit on IndexedDB: bring over what localStorage holds, check it landed, then clear localStorage.
        const old = safeParse(ls.get(LIST_KEY), null);
        const oldLogo = ls.get(LOGO_KEY);
        const take = isList(old) && !Object.keys(list).length ? old : null;
        tx = db.transaction(['docs', 'meta'], 'readwrite');
        const docs = tx.objectStore('docs');
        const meta = tx.objectStore('meta');
        if (take) Object.keys(take).forEach(num => { if (!UNSAFE.includes(num) && isList(take[num])) docs.put(take[num], num); });
        if (typeof oldLogo === 'string' && oldLogo && !logo) meta.put(oldLogo, 'logo');
        meta.put(true, 'migrated');
        await done(tx);
        if (take) Object.keys(take).forEach(num => { if (!UNSAFE.includes(num) && isList(take[num])) list[num] = take[num]; });
        if (typeof oldLogo === 'string' && oldLogo && !logo) logo = oldLogo;
        // Only clear localStorage when everything in it is now in IndexedDB; leftovers stay put, untouched.
        const leftover = isList(old) && Object.keys(old).length > 0 && !take;
        if (!leftover) { ls.remove(LIST_KEY); ls.remove(LOGO_KEY); }
      }

      persisted.clear();
      Object.keys(list).forEach(num => persisted.set(num, JSON.stringify(list[num])));
      cacheJson = JSON.stringify(list);
      cacheLogo = logo;
      cacheDeleted = isList(result(deletedReq)) ? pruneDeleted(result(deletedReq), now()) : {};
      api.ready = true;
      return { list, logo, deleted: { ...cacheDeleted } };
    } catch (e) {
      fallBack(e);
      return { list: safeParse(ls.get(LIST_KEY), {}), logo: ls.get(LOGO_KEY), deleted: api.getDeleted() };
    }
  };

  // The saved list as JSON text (null when nothing is saved yet).
  api.getList = () => (api.mode === 'localstorage' ? ls.get(LIST_KEY) : cacheJson);

  // Saves the whole list (JSON text). Documents that changed are stamped with updatedAt; `keepStamps` leaves
  // the stamps as given (documents arriving from a backup or folder). Returns { ok, json } where json is the list
  // as stored, stamps included. ok is false when it could not be saved (storage full, or not loaded yet).
  api.setList = (json, keepStamps) => {
    const next = safeParse(json, null);
    if (!isList(next)) return { ok: false, json };
    const prev = safeParse(api.getList(), {});
    const stamped = stampChanges(prev, next, now(), !!keepStamps);
    const out = JSON.stringify(stamped);
    if (api.mode === 'localstorage') {
      const ok = ls.set(LIST_KEY, out);
      if (ok && !keepStamps) recordDeletions(prev, stamped);
      return { ok, json: out };
    }
    if (!api.ready) return { ok: false, json: out };
    cacheJson = out;
    pending = stamped;
    chain = chain.then(persist);
    if (!keepStamps) recordDeletions(prev, stamped);
    return { ok: true, json: out };
  };

  // A document that left the list was deleted: remember when. A document that is back with a later edit time
  // than its record (the number was reused) clears the record. With keepStamps the caller (a merge or an import)
  // manages the records itself through setDeleted.
  function recordDeletions(prev, next) {
    const deleted = api.getDeleted();
    let changed = false;
    Object.keys(prev).forEach(num => {
      if (!Object.prototype.hasOwnProperty.call(next, num)) { deleted[num] = Math.max(now(), (deleted[num] || 0) + 1); changed = true; }
    });
    Object.keys(next).forEach(num => {
      if (Object.prototype.hasOwnProperty.call(deleted, num) && editTime(next[num]) > deleted[num]) { delete deleted[num]; changed = true; }
    });
    if (changed) api.setDeleted(deleted);
  }

  // Deletion records: { number: deletedAt }.
  api.getDeleted = () => {
    if (api.mode === 'localstorage') { const d = safeParse(ls.get(DELETED_KEY), {}); return isList(d) ? d : {}; }
    return { ...cacheDeleted };
  };

  // Replaces all deletion records (old ones are dropped). Returns false when they could not be saved.
  api.setDeleted = (deleted) => {
    const clean = pruneDeleted(deleted, now());
    if (api.mode === 'localstorage') return ls.set(DELETED_KEY, JSON.stringify(clean));
    if (!api.ready) return false;
    cacheDeleted = clean;
    chain = chain.then(async () => {
      if (!db) return;
      try {
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put({ ...clean }, 'deleted');
        await done(tx);
      } catch (e) { if (onError) onError(e); }
    });
    return true;
  };

  // Writes whatever differs between the latest list and the database, in one transaction. A failure leaves the
  // database record of each document as it was, so the next save tries again.
  async function persist() {
    if (!pending || !db) return;
    const list = pending;
    pending = null;
    const puts = [];
    const dels = [];
    Object.keys(list).forEach(num => {
      const text = JSON.stringify(list[num]);
      if (persisted.get(num) !== text) puts.push([num, list[num], text]);
    });
    persisted.forEach((_, num) => { if (!Object.prototype.hasOwnProperty.call(list, num)) dels.push(num); });
    if (!puts.length && !dels.length) return;
    try {
      const tx = db.transaction('docs', 'readwrite');
      const store = tx.objectStore('docs');
      puts.forEach(([num, doc]) => store.put(doc, num));
      dels.forEach(num => store.delete(num));
      await done(tx);
      puts.forEach(([num, , text]) => persisted.set(num, text));
      dels.forEach(num => persisted.delete(num));
    } catch (e) {
      if (onError) onError(e);
    }
  }

  api.getLogo = () => (api.mode === 'localstorage' ? ls.get(LOGO_KEY) : cacheLogo);

  // `dataUrl` null removes the logo. Returns false when it could not be saved.
  api.setLogo = (dataUrl) => {
    if (api.mode === 'localstorage') {
      if (!dataUrl) { ls.remove(LOGO_KEY); return true; }
      return ls.set(LOGO_KEY, dataUrl);
    }
    if (!api.ready) return false;
    cacheLogo = dataUrl || null;
    chain = chain.then(async () => {
      if (!db) return;
      try {
        const tx = db.transaction('meta', 'readwrite');
        if (dataUrl) tx.objectStore('meta').put(dataUrl, 'logo'); else tx.objectStore('meta').delete('logo');
        await done(tx);
      } catch (e) { if (onError) onError(e); }
    });
    return true;
  };

  // Resolves when every write so far has reached the database.
  api.flush = () => chain;

  return api;
}

if (typeof module === 'object') module.exports = { createStorage };
