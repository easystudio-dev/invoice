// storage.js against a fake IndexedDB and a fake localStorage.
const test = require('node:test');
const assert = require('node:assert');
const { createStorage } = require('./storage.js');
const { newIdb, inv } = require('./test-helpers.js');

function fakeLs(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, get: k => (map.has(k) ? map.get(k) : null), set(k, v) { if (this.full) return false; map.set(k, v); return true; }, remove: k => { map.delete(k); }, full: false };
}
const make = (o = {}) => createStorage({ ls: fakeLs(), now: () => 1000, ...o });
const list = s => JSON.parse(s.getList());
const put = (s, obj, keep) => s.setList(JSON.stringify(obj), keep);

test('IndexedDB: documents saved in one session load in the next, stamped', async () => {
  const idb = newIdb();
  const a = make({ indexedDB: idb });
  assert.strictEqual(a.mode, 'indexeddb');
  assert.strictEqual(a.ready, false);
  assert.deepStrictEqual(await a.load(), { list: {}, logo: null });
  assert.strictEqual(a.ready, true);
  assert.strictEqual(put(a, { 'INV-0001': inv('INV-0001') }).ok, true);
  assert.strictEqual(list(a)['INV-0001'].updatedAt, 1000); // readable at once, before the database write finishes
  a.setLogo('data:image/png;base64,AAAA');
  await a.flush();

  const b = make({ indexedDB: idb });
  const loaded = await b.load();
  assert.deepStrictEqual(Object.keys(loaded.list), ['INV-0001']);
  assert.strictEqual(loaded.list['INV-0001'].updatedAt, 1000);
  assert.strictEqual(loaded.logo, 'data:image/png;base64,AAAA');
  assert.strictEqual(b.getLogo(), 'data:image/png;base64,AAAA');
});

test('IndexedDB: only changed documents are written, deletions and logo removal reach the database', async () => {
  const idb = newIdb();
  const a = make({ indexedDB: idb });
  await a.load();
  put(a, { A: inv('A'), B: inv('B') });
  await a.flush();
  put(a, { A: inv('A'), B: inv('B', { notes: 'x' }) });
  await a.flush();
  put(a, { B: inv('B', { notes: 'x' }) });
  a.setLogo('data:x');
  await a.flush();
  a.setLogo(null);
  await a.flush();
  const b = make({ indexedDB: idb });
  const loaded = await b.load();
  assert.deepStrictEqual(Object.keys(loaded.list), ['B']);
  assert.strictEqual(loaded.list.B.notes, 'x');
  assert.strictEqual(loaded.logo, null);
});

test('IndexedDB: nothing can be saved before load finishes', async () => {
  const a = make({ indexedDB: newIdb() });
  assert.strictEqual(put(a, { A: inv('A') }).ok, false);
  assert.strictEqual(a.setLogo('data:x'), false);
  await a.load();
  assert.strictEqual(put(a, { A: inv('A') }).ok, true);
});

test('IndexedDB: re-saving unchanged keeps the stamp, a change moves it; keepStamps leaves stamps as given', async () => {
  let t = 1000;
  const a = make({ indexedDB: newIdb(), now: () => t });
  await a.load();
  put(a, { A: inv('A') });
  t = 2000;
  put(a, { A: inv('A') });
  assert.strictEqual(list(a).A.updatedAt, 1000);
  put(a, { A: inv('A', { notes: 'x' }) });
  assert.strictEqual(list(a).A.updatedAt, 2000);
  put(a, { A: { ...inv('A'), updatedAt: 7 }, B: { ...inv('B'), updatedAt: 9 } }, true);
  assert.deepStrictEqual([list(a).A.updatedAt, list(a).B.updatedAt], [7, 9]);
});

test('IndexedDB: first run moves localStorage documents and logo over, then clears them', async () => {
  const idb = newIdb();
  const ls = fakeLs({ 'invoice-list': JSON.stringify({ A: inv('A'), B: inv('B') }), 'invoice-logo': 'data:old', theme: 'dark' });
  const a = make({ indexedDB: idb, ls });
  const loaded = await a.load();
  assert.deepStrictEqual(Object.keys(loaded.list), ['A', 'B']);
  assert.strictEqual(loaded.logo, 'data:old');
  assert.strictEqual(ls.map.has('invoice-list'), false);
  assert.strictEqual(ls.map.has('invoice-logo'), false);
  assert.strictEqual(ls.map.get('theme'), 'dark'); // other settings stay
  const b = make({ indexedDB: idb });
  assert.deepStrictEqual(Object.keys((await b.load()).list), ['A', 'B']);
});

test('IndexedDB: a stale localStorage list is never imported a second time', async () => {
  const idb = newIdb();
  const a = make({ indexedDB: idb });
  await a.load();
  put(a, { A: inv('A') });
  await a.flush();
  put(a, {});
  await a.flush();
  const b = make({ indexedDB: idb, ls: fakeLs({ 'invoice-list': JSON.stringify({ OLD: inv('OLD') }) }) });
  assert.deepStrictEqual((await b.load()).list, {});
});

test('IndexedDB: a database that already holds documents is not mixed with localStorage ones, which stay untouched', async () => {
  const idb = newIdb();
  // A database with documents but no "migrated" flag, as if made by something else.
  await new Promise((resolve, reject) => {
    const req = idb.open('invoice-data', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('docs'); req.result.createObjectStore('meta'); };
    req.onsuccess = () => {
      const tx = req.result.transaction('docs', 'readwrite');
      tx.objectStore('docs').put(inv('A'), 'A');
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
  const ls = fakeLs({ 'invoice-list': JSON.stringify({ OLD: inv('OLD') }) });
  const loaded = await make({ indexedDB: idb, ls }).load();
  assert.deepStrictEqual(Object.keys(loaded.list), ['A']);
  assert.strictEqual(ls.map.has('invoice-list'), true);
});

test('falls back to localStorage when IndexedDB will not open, and keeps the data there', async () => {
  for (const broken of [
    { open() { throw new Error('blocked by browser'); } },
    { open() { const req = {}; setTimeout(() => { req.error = new Error('denied'); req.onerror(); }); return req; } },
  ]) {
    const ls = fakeLs({ 'invoice-list': JSON.stringify({ A: inv('A') }), 'invoice-logo': 'data:x' });
    const a = make({ indexedDB: broken, ls });
    assert.strictEqual(a.mode, 'indexeddb');
    const loaded = await a.load();
    assert.strictEqual(a.mode, 'localstorage');
    assert.strictEqual(a.ready, true);
    assert.ok(a.fallbackReason);
    assert.deepStrictEqual(Object.keys(loaded.list), ['A']);
    assert.strictEqual(a.getLogo(), 'data:x');
    assert.strictEqual(put(a, { A: inv('A'), B: inv('B') }).ok, true);
    assert.deepStrictEqual(Object.keys(JSON.parse(ls.map.get('invoice-list'))), ['A', 'B']);
  }
});

test('localStorage mode: reads and writes go straight to localStorage; a full one reports failure', async () => {
  const ls = fakeLs();
  const a = make({ ls });
  assert.strictEqual(a.mode, 'localstorage');
  assert.strictEqual(a.ready, true);
  assert.strictEqual(a.getList(), null);
  assert.strictEqual(put(a, { A: inv('A') }).ok, true);
  assert.strictEqual(JSON.parse(ls.map.get('invoice-list')).A.updatedAt, 1000);
  ls.map.set('invoice-list', JSON.stringify({ Z: inv('Z') })); // changed behind our back: still read live
  assert.deepStrictEqual(Object.keys(list(a)), ['Z']);
  assert.strictEqual(a.setLogo('data:x'), true);
  assert.strictEqual(a.getLogo(), 'data:x');
  a.setLogo(null);
  assert.strictEqual(a.getLogo(), null);
  ls.full = true;
  assert.strictEqual(put(a, { A: inv('A') }).ok, false);
  assert.strictEqual(a.setLogo('data:y'), false);
});

test('rejects a list that is not a plain object', () => {
  const a = make();
  for (const bad of ['nope', '[]', 'null', '"x"']) assert.strictEqual(a.setList(bad).ok, false);
});
