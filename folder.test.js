// folder.js against an in-memory fake folder.
const test = require('node:test');
const assert = require('node:assert');
const { createFolderSync } = require('./folder.js');
const { fakeDir, inv } = require('./test-helpers.js');

function setup(dir = fakeDir()) {
  const store = new Map();
  const states = [];
  const kv = { get: async k => store.get(k), set: async (k, v) => { store.set(k, v); }, del: async k => { store.delete(k); } };
  const sync = createFolderSync({ pick: async () => dir, kv, onState: (s, i) => states.push([s, i.message]), delay: 0 });
  return { dir, sync, kv, store, states };
}

test('mirrors saved documents into one folder per client', async () => {
  const { dir, sync } = setup();
  assert.deepStrictEqual(await sync.choose(), {});
  sync.mirror({ 'INV-0001': inv('INV-0001', { toName: 'Acme Ltd' }), 'INV-0002': inv('INV-0002', { toName: '' }) });
  await sync.flush();
  assert.deepStrictEqual(Object.keys(dir.files()).sort(), ['Acme Ltd/INV-0001.json', 'No client/INV-0002.json']);
  assert.strictEqual(JSON.parse(dir.files()['Acme Ltd/INV-0001.json']).invNumber, 'INV-0001');
});

test('renaming the client moves the file and drops the emptied folder; deleting removes the file', async () => {
  const { dir, sync } = setup();
  await sync.choose();
  sync.mirror({ 'INV-0001': inv('INV-0001', { toName: 'Acme' }) });
  await sync.flush();
  sync.mirror({ 'INV-0001': inv('INV-0001', { toName: 'Beta' }) });
  await sync.flush();
  assert.deepStrictEqual(Object.keys(dir.files()), ['Beta/INV-0001.json']);
  assert.deepStrictEqual(dir.folders(), ['Beta']);
  sync.mirror({});
  await sync.flush();
  assert.deepStrictEqual(dir.files(), {});
});

test('never touches files it did not write', async () => {
  const dir = fakeDir();
  dir.put('Acme/notes.txt', 'mine');
  dir.put('Acme/INV-0001 old copy.json', JSON.stringify(inv('INV-0001', { toName: 'Acme' })));
  const { sync } = setup(dir);
  const docs = await sync.choose();
  assert.deepStrictEqual(Object.keys(docs), ['INV-0001']);
  sync.mirror({}); // INV-0001 deleted in the app; the copy sits at a path we never planned
  await sync.flush();
  assert.deepStrictEqual(Object.keys(dir.files()).sort(), ['Acme/INV-0001 old copy.json', 'Acme/notes.txt']);
});

test('a document found where we would put it is tracked, so deleting it removes the file', async () => {
  const dir = fakeDir();
  const { sync } = setup(dir);
  await sync.choose();
  sync.mirror({ 'INV-0001': inv('INV-0001') });
  await sync.flush();
  const again = setup(dir);
  assert.deepStrictEqual(Object.keys(await again.sync.choose()), ['INV-0001']);
  again.sync.mirror({});
  await again.sync.flush();
  assert.deepStrictEqual(dir.files(), {});
});

test('reads documents already in the folder and skips junk', async () => {
  const dir = fakeDir();
  dir.put('Acme/INV-0001.json', JSON.stringify(inv('INV-0001')));
  dir.put('Acme/broken.json', '{nope');
  dir.put('Acme/list.json', '[1]');
  dir.put('Acme/readme.txt', 'hi');
  dir.put('top-level.json', JSON.stringify(inv('INV-0009')));
  const { sync } = setup(dir);
  assert.deepStrictEqual(Object.keys(await sync.choose()), ['INV-0001']);
});

test('mirror does nothing until a folder is connected, and not after disconnecting', async () => {
  const { dir, sync, store } = setup();
  sync.mirror({ 'INV-0001': inv('INV-0001') });
  await sync.flush();
  assert.deepStrictEqual(dir.files(), {});
  await sync.choose();
  assert.ok(store.has('handle'));
  await sync.disconnect();
  assert.strictEqual(store.has('handle'), false);
  assert.strictEqual(sync.state, 'off');
  sync.mirror({ 'INV-0001': inv('INV-0001') });
  await sync.flush();
  assert.deepStrictEqual(dir.files(), {});
});

test('resume: nothing remembered → off; permission kept → ready; permission lost → reconnect from a click', async () => {
  const dir = fakeDir();
  dir.put('A/INV-0001.json', JSON.stringify(inv('INV-0001')));
  const first = setup(dir);
  assert.strictEqual(await first.sync.resume(), null);
  assert.strictEqual(first.sync.state, 'off');
  await first.sync.choose();

  const second = setup(dir);
  second.store.set('handle', dir);
  assert.deepStrictEqual(Object.keys(await second.sync.resume()), ['INV-0001']);
  assert.strictEqual(second.sync.state, 'ready');

  dir.permission = 'prompt';
  const third = setup(dir);
  third.store.set('handle', dir);
  assert.strictEqual(await third.sync.resume(), null);
  assert.strictEqual(third.sync.state, 'needs-permission');
  assert.strictEqual(third.sync.name, 'Invoices');
  assert.strictEqual(await third.sync.reconnect(), null); // still refused
  dir.permission = 'granted';
  assert.deepStrictEqual(Object.keys(await third.sync.reconnect()), ['INV-0001']);
  assert.strictEqual(third.sync.state, 'ready');
});

test('a write the browser refuses asks for permission again; any other failure is reported and retried', async () => {
  const { dir, sync } = setup();
  await sync.choose();
  dir.failWrites = 'NotAllowedError';
  sync.mirror({ 'INV-0001': inv('INV-0001') });
  await sync.flush();
  assert.strictEqual(sync.state, 'needs-permission');

  const b = setup();
  await b.sync.choose();
  b.dir.failWrites = 'QuotaExceededError';
  b.sync.mirror({ 'INV-0001': inv('INV-0001') });
  await b.sync.flush();
  assert.strictEqual(b.sync.state, 'error');
  b.dir.failWrites = null;
  b.sync.mirror({ 'INV-0001': inv('INV-0001') });
  await b.sync.flush();
  assert.strictEqual(b.sync.state, 'ready');
  assert.deepStrictEqual(Object.keys(b.dir.files()), ['Client/INV-0001.json']);
});

test('still works when the folder cannot be remembered', async () => {
  const dir = fakeDir();
  const sync = createFolderSync({ pick: async () => dir, kv: { get: async () => { throw new Error('x'); }, set: async () => { throw new Error('x'); }, del: async () => {} }, delay: 0 });
  await sync.choose();
  sync.mirror({ 'INV-0001': inv('INV-0001') });
  await sync.flush();
  assert.strictEqual(Object.keys(dir.files()).length, 1);
});
