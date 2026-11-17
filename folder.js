// Mirrors saved documents into a folder the user picked (File System Access API, Chromium only).
// The app keeps working from localStorage; this copies every change into <folder>/<client>/<number>.json.
// Loaded as a plain script in the browser, require()'d by folder.test.js with fake folder handles.
const folderLib = typeof module === 'object' ? require('./lib.js') : { folderPlan, diffPlan, parseFolderDoc, parseTombstone, DELETED_FOLDER };

const MAX_DOC_BYTES = 5 * 1024 * 1024;

// env.pick()       → a directory handle (showDirectoryPicker); rejects with AbortError when cancelled
// env.kv           → { get, set, del } to remember the handle between visits (IndexedDB)
// env.onState      → (state, { name, message }) where state is 'off' | 'needs-permission' | 'ready' | 'error'
// env.delay        → ms to wait for edits to settle before writing (default 250)
function createFolderSync(env) {
  const { folderPlan, diffPlan, parseFolderDoc, parseTombstone, DELETED_FOLDER } = folderLib;
  const kv = env.kv;
  const HANDLE_KEY = 'handle';
  let root = null;     // directory handle, once we may read and write it
  let handle = null;   // remembered handle, even while permission is missing
  let synced = {};     // { path: text } for the files we wrote or found in exactly the shape we'd write them
  let latest = null; // { list, deleted } waiting to be written
  let timer = null;
  let chain = Promise.resolve();
  const api = { state: 'off', name: '', listKey: 'invoice-list' };

  function setState(state, message = '') {
    api.state = state;
    api.name = handle ? handle.name : '';
    if (env.onState) env.onState(state, { name: api.name, message });
  }

  // Everything in the folder: { docs: { number: doc }, deleted: { number: deletedAt } }. Documents come from the
  // client subfolders, deletion records from '_deleted'. Also sets the baseline of files we track.
  async function readFolder(dir) {
    const docs = {};
    const deleted = {};
    const found = {};
    const paths = [];
    for await (const [dirName, sub] of dir.entries()) {
      if (sub.kind !== 'directory') continue;
      for await (const [fileName, file] of sub.entries()) {
        if (file.kind === 'file' && /\.json$/i.test(fileName)) paths.push([`${dirName}/${fileName}`, file]);
      }
    }
    paths.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [path, fileHandle] of paths) {
      const file = await fileHandle.getFile();
      if (file.size > MAX_DOC_BYTES) continue;
      const text = await file.text();
      if (path.startsWith(`${DELETED_FOLDER}/`)) {
        const rec = parseTombstone(text);
        if (rec) { deleted[rec[0]] = Math.max(deleted[rec[0]] || 0, rec[1]); found[path] = text; }
        continue;
      }
      const parsed = parseFolderDoc(text, path.split('/').pop().replace(/\.json$/i, ''));
      if (!parsed || Object.prototype.hasOwnProperty.call(docs, parsed[0])) continue; // first copy wins; others are left alone
      docs[parsed[0]] = parsed[1];
      found[path] = text;
    }
    // Track only the files that sit exactly where we would put them. A copy the user moved or renamed
    // stays theirs: we never remove a path we didn't plan.
    const plan = folderPlan(docs, deleted);
    synced = {};
    Object.keys(plan).forEach(p => { if (found[p] !== undefined) synced[p] = found[p]; });
    return { docs, deleted };
  }

  async function writeFile(path, text) {
    const [dirName, fileName] = path.split('/');
    const dir = await root.getDirectoryHandle(dirName, { create: true });
    const file = await dir.getFileHandle(fileName, { create: true });
    const w = await file.createWritable(); // the file only changes when close() succeeds
    await w.write(text);
    await w.close();
  }

  async function removeFile(path) {
    const [dirName, fileName] = path.split('/');
    let dir;
    try { dir = await root.getDirectoryHandle(dirName); } catch (e) { if (e.name === 'NotFoundError') return; throw e; }
    try { await dir.removeEntry(fileName); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
    try { await root.removeEntry(dirName); } catch { /* not empty: it holds other files, leave it */ }
  }

  async function push(list, deleted) {
    if (!root) return;
    const plan = folderPlan(list, deleted);
    const { write, remove } = diffPlan(synced, plan);
    try {
      for (const path of write) { await writeFile(path, plan[path]); synced[path] = plan[path]; }
      for (const path of remove) { await removeFile(path); delete synced[path]; }
      if (api.state !== 'ready') setState('ready');
    } catch (e) {
      if (e && e.name === 'NotAllowedError') { root = null; setState('needs-permission'); }
      else setState('error', (e && e.message) || 'Could not write to the folder');
    }
  }

  async function open(dir) {
    root = dir;
    handle = dir;
    const docs = await readFolder(dir);
    setState('ready');
    return docs;
  }

  // First visit: ask for a folder. Returns what is already in it: { docs, deleted }.
  api.choose = async () => {
    const dir = await env.pick();
    try { await kv.set(HANDLE_KEY, dir); } catch { /* can't remember it: it still works this visit */ }
    return open(dir);
  };

  // Later visits: use the remembered folder if the browser still lets us. Returns its { docs, deleted }, or null.
  api.resume = async () => {
    try { handle = (await kv.get(HANDLE_KEY)) || null; } catch { handle = null; }
    if (!handle) { setState('off'); return null; }
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') { setState('needs-permission'); return null; }
    return open(handle);
  };

  // Must run from a click: the browser only shows its permission prompt then.
  api.reconnect = async () => {
    if (!handle) return api.choose();
    if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') { setState('needs-permission'); return null; }
    return open(handle);
  };

  api.disconnect = async () => {
    clearTimeout(timer);
    latest = null;
    root = null;
    synced = {};
    try { await kv.del(HANDLE_KEY); } catch { /* nothing to forget */ }
    handle = null;
    setState('off');
  };

  // Called with the whole saved list and the deletion records after every change. Writes are debounced and run
  // one at a time.
  api.mirror = (list, deleted) => {
    if (!root) return;
    latest = { list, deleted: deleted || {} };
    clearTimeout(timer);
    timer = setTimeout(api.flush, env.delay ?? 250);
  };

  // Writes now whatever is waiting; resolves when the folder is up to date.
  api.flush = () => {
    clearTimeout(timer);
    if (latest) { const { list, deleted } = latest; latest = null; chain = chain.then(() => push(list, deleted)); }
    return chain;
  };

  return api;
}

// Remembers the folder handle between visits. Directory handles can be stored in IndexedDB but not localStorage.
function idbKv() {
  const open = () => new Promise((resolve, reject) => {
    const req = indexedDB.open('invoice-folder', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = (mode, fn) => open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => { db.close(); resolve(req.result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
  }));
  return { get: k => run('readonly', s => s.get(k)), set: (k, v) => run('readwrite', s => s.put(v, k)), del: k => run('readwrite', s => s.delete(k)) };
}

if (typeof module === 'object') module.exports = { createFolderSync };
