// Boots index.html + lib.js + app.js in jsdom for browser-level tests. Not loaded by the app.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const html = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '');

// seed: localStorage entries set before the app starts. confirm: answer for confirm() dialogs.
// folder: a fakeDir() the folder picker will hand back (Chromium's showDirectoryPicker).
function boot({ seed = {}, blockStorage = false, confirm = true, narrow = false, folder = null } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: narrow, addEventListener() {} });
  w.alerts = [];
  w.alert = msg => w.alerts.push(msg);
  w.confirm = () => confirm;
  w.print = () => {};
  for (const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  if (blockStorage) {
    Object.defineProperty(w, 'localStorage', {
      get() { throw new w.DOMException('The operation is insecure.', 'SecurityError'); },
    });
  }
  if (folder) { w.showDirectoryPicker = async () => folder; w.indexedDB = {}; }
  w.eval(read('lib.js'));
  w.eval(read('folder.js'));
  w.eval(read('vendor/qrcode.js'));
  w.eval(read('app.js'));
  const d = w.document;
  const $ = sel => d.querySelector(sel);
  // Set a field's value and fire the events a real edit would.
  const type = (el, value) => {
    if (typeof el === 'string') el = $(el);
    if (el.type === 'checkbox') el.checked = value; else el.value = value;
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
  };
  const saved = () => JSON.parse(w.localStorage.getItem('invoice-list') || '{}');
  return { w, d, $, type, saved };
}

// A saved-invoice record as the app stores it.
function inv(num, extra = {}) {
  return { invNumber: num, docType: 'invoice', toName: 'Client', paid: false, vatToggle: false, vatRate: '15',
    currency: 'ZAR', items: [{ desc: 'Work', qty: '1', price: '100' }], ...extra };
}

// An in-memory stand-in for a FileSystemDirectoryHandle: enough of the API for folder.js.
function fakeDir(name = 'Invoices', shared = { failWrites: null }) {
  const map = new Map();
  const err = (n, msg) => Object.assign(new Error(msg), { name: n });
  const dir = {
    kind: 'directory', name, map, permission: 'granted',
    get failWrites() { return shared.failWrites; }, set failWrites(v) { shared.failWrites = v; }, // one switch for the whole tree
    async *entries() { for (const e of [...map]) yield e; },
    async getDirectoryHandle(n, { create } = {}) {
      let h = map.get(n);
      if (!h) { if (!create) throw err('NotFoundError', 'not found'); h = fakeDir(n, shared); map.set(n, h); }
      if (h.kind !== 'directory') throw err('TypeMismatchError', 'not a folder');
      return h;
    },
    async getFileHandle(n, { create } = {}) {
      let h = map.get(n);
      if (!h) { if (!create) throw err('NotFoundError', 'not found'); h = fakeFile(n, shared); map.set(n, h); }
      return h;
    },
    async removeEntry(n) {
      const h = map.get(n);
      if (!h) throw err('NotFoundError', 'not found');
      if (h.kind === 'directory' && h.map.size) throw err('InvalidModificationError', 'not empty');
      map.delete(n);
    },
    async queryPermission() { return dir.permission; },
    async requestPermission() { return dir.permission; },
    // Test shortcuts: put a file at 'Client/INV-1.json', read it back, list all paths.
    put(path, text) {
      const parts = path.split('/');
      let d = dir;
      parts.slice(0, -1).forEach(p => { if (!d.map.has(p)) d.map.set(p, fakeDir(p, shared)); d = d.map.get(p); });
      const f = fakeFile(parts.at(-1), shared); f.text = text; d.map.set(f.name, f);
    },
    files() {
      const out = {};
      const walk = (d, prefix) => d.map.forEach((h, n) => (h.kind === 'directory' ? walk(h, prefix + n + '/') : (out[prefix + n] = h.text)));
      walk(dir, '');
      return out;
    },
    folders() { return [...map].filter(([, h]) => h.kind === 'directory').map(([n]) => n).sort(); },
  };
  return dir;
}
function fakeFile(name, shared) {
  const f = {
    kind: 'file', name, text: '',
    async getFile() { return { size: f.text.length, text: async () => f.text }; },
    async createWritable() {
      if (shared.failWrites) throw Object.assign(new Error('blocked'), { name: shared.failWrites });
      let buf = '';
      return { write: async t => { buf += t; }, close: async () => { f.text = buf; } };
    },
  };
  return f;
}

module.exports = { boot, inv, fakeDir };
