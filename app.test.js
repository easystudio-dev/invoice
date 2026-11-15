// Browser-level tests: the real index.html + app.js in jsdom. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const { boot, inv } = require('./test-helpers.js');

test('app starts when the browser blocks storage', () => {
  const { $, d } = boot({ blockStorage: true });
  assert.strictEqual(d.querySelectorAll('#itemsBody tr').length, 1);
  assert.ok($('#invNumber').value);
});

test('Paid on an unsaved draft leaves a saved invoice with the same number alone', () => {
  const { $, d, type, saved } = boot({ seed: { 'invoice-list': { 'INV-0003': inv('INV-0003'), 'INV-0004': inv('INV-0004') } } });
  [...d.querySelectorAll('.ledger-row')].find(r => r.textContent.includes('INV-0003')).click();
  $('#newInvoiceBtn').click();
  type('#invNumber', 'INV-0004');
  type('#paid', true);
  assert.strictEqual(saved()['INV-0004'].paid, false);
});

test('Paid on an opened saved invoice updates its saved copy', () => {
  const { d, type, saved } = boot({ seed: { 'invoice-list': { 'INV-0003': inv('INV-0003') } } });
  d.querySelector('.ledger-row').click();
  type('#paid', true);
  assert.strictEqual(saved()['INV-0003'].paid, true);
});

test('New from an old invoice skips numbers already saved', () => {
  const { $, d } = boot({ seed: { 'invoice-list': { 'INV-0003': inv('INV-0003'), 'INV-0004': inv('INV-0004') } } });
  [...d.querySelectorAll('.ledger-row')].find(r => r.textContent.includes('INV-0003')).click();
  $('#newInvoiceBtn').click();
  assert.strictEqual($('#invNumber').value, 'INV-0005');
});

test('totals update from line items and VAT', () => {
  const { $, d, type } = boot();
  const row = d.querySelector('#itemsBody tr');
  type(row.querySelector('.item-qty'), '2');
  type(row.querySelector('.item-price'), '100');
  type('#vatToggle', true);
  assert.match($('#grandTotal').textContent, /230/);
  assert.strictEqual($('.doc-title').textContent, 'TAX INVOICE');
});

test('discount lowers the grand total (before VAT), saves and restores', () => {
  const { $, d, type, saved } = boot();
  const row = d.querySelector('#itemsBody tr');
  type(row.querySelector('.item-qty'), '2');
  type(row.querySelector('.item-price'), '100');
  type('#vatToggle', true);
  type('#discountValue', '10'); // 10% off 200 = 180, +15% VAT = 207
  assert.match($('#grandTotal').textContent, /207/);
  assert.match($('#discountAmount').textContent, /-R\s*20/);
  assert.strictEqual($('#discountPrintLabel').textContent, 'Discount (10%)');
  assert.ok(!$('#discountRow').classList.contains('discount-zero'));
  type('#discountType', 'amount');
  type('#discountValue', '50'); // 150 + 22.50
  assert.match($('#grandTotal').textContent, /172/);
  assert.strictEqual($('#discountPrintLabel').textContent, 'Discount');
  $('#saveInvoiceBtn').click();
  const num = $('#invNumber').value;
  assert.strictEqual(saved()[num].discountType, 'amount');
  assert.strictEqual(saved()[num].discountValue, '50');
  $('#newInvoiceBtn').click();
  assert.strictEqual($('#discountValue').value, '');
  assert.ok($('#discountRow').classList.contains('discount-zero'));
  d.querySelector('.ledger-row').click();
  assert.strictEqual($('#discountValue').value, '50');
  assert.match($('#grandTotal').textContent, /172/);
});

test('ledger total includes the discount', () => {
  const { d } = boot({ seed: { 'invoice-list': { 'INV-0001': inv('INV-0001', { discountType: 'percent', discountValue: '50' }) } } });
  assert.match(d.querySelector('.ledger-amount').textContent, /50/);
});

test('old saved invoice without discount or unit opens cleanly', () => {
  const old = inv('INV-0007');
  const { $, d, w } = boot({ seed: { 'invoice-list': { 'INV-0007': old } } });
  d.querySelector('.ledger-row').click();
  assert.strictEqual($('#discountValue').value, '');
  assert.strictEqual($('#discountType').value, 'percent');
  assert.strictEqual($('.item-unit').value, '');
  assert.match($('#grandTotal').textContent, /100/);
  assert.ok($('#discountRow').classList.contains('discount-zero'));
  assert.strictEqual(w.alerts.length, 0);
});

test('unit is saved and restored; qty accepts fractions', () => {
  const { $, d, type, saved } = boot();
  const row = d.querySelector('#itemsBody tr');
  assert.strictEqual(row.querySelector('.item-qty').step, 'any');
  type(row.querySelector('.item-qty'), '1.5');
  type(row.querySelector('.item-unit'), 'hrs');
  type(row.querySelector('.item-price'), '100');
  assert.match($('#grandTotal').textContent, /150/);
  $('#saveInvoiceBtn').click();
  assert.strictEqual(Object.values(saved())[0].items[0].unit, 'hrs');
  $('#newInvoiceBtn').click();
  assert.strictEqual($('.item-unit').value, '');
  d.querySelector('.ledger-row').click();
  assert.strictEqual($('.item-unit').value, 'hrs');
});

test('move down then up reorders rows, saves the order and keeps focus on the button', () => {
  const { $, d, type, saved } = boot();
  $('#addItem').click();
  $('#addItem').click();
  const descs = () => [...d.querySelectorAll('.item-desc')].map(t => t.value);
  [...d.querySelectorAll('.item-desc')].forEach((t, i) => type(t, 'ABC'[i]));
  const draft = () => JSON.parse(d.defaultView.localStorage.getItem('invoice-draft')).items.map(i => i.desc);
  const rows = () => [...d.querySelectorAll('#itemsBody tr')];
  rows()[0].querySelector('.move-down').click();
  assert.deepStrictEqual(descs(), ['B', 'A', 'C']);
  assert.deepStrictEqual(draft(), ['B', 'A', 'C']);
  assert.strictEqual(d.activeElement, rows()[1].querySelector('.move-down'));
  rows()[1].querySelector('.move-down').click();
  assert.deepStrictEqual(descs(), ['B', 'C', 'A']);
  assert.strictEqual(rows()[2].querySelector('.move-down').getAttribute('aria-disabled'), 'true');
  rows()[2].querySelector('.move-down').click(); // no-op at the end
  assert.deepStrictEqual(descs(), ['B', 'C', 'A']);
  rows()[2].querySelector('.move-up').click();
  assert.deepStrictEqual(draft(), ['B', 'A', 'C']);
  $('#saveInvoiceBtn').click();
  assert.deepStrictEqual(Object.values(saved())[0].items.map(i => i.desc), ['B', 'A', 'C']);
});

test('Prices include VAT: extracts VAT, relabels the totals and is kept by New invoice', () => {
  const { $, d, type, saved } = boot();
  const row = d.querySelector('#itemsBody tr');
  type(row.querySelector('.item-price'), '115');
  assert.ok($('#vatInclusiveRow').hidden); // only offered when VAT is on
  type('#vatToggle', true);
  assert.ok(!$('#vatInclusiveRow').hidden);
  assert.match($('#grandTotal').textContent, /132[,.]25/);
  assert.strictEqual($('#subtotalLabel').textContent, 'Subtotal (excl. VAT)');
  assert.ok($('#netRow').hidden);
  type('#vatInclusive', true);
  assert.match($('#grandTotal').textContent, /115[,.]00/);
  assert.match($('#vatAmount').textContent, /15[,.]00/);
  assert.match($('#netAmount').textContent, /100[,.]00/);
  assert.ok(!$('#netRow').hidden);
  assert.strictEqual($('#subtotalLabel').textContent, 'Subtotal (incl. VAT)');
  assert.strictEqual($('#totalLabel').textContent, 'Total incl. VAT');
  assert.strictEqual($('#vatPrintLabel').textContent, 'VAT (15%)');
  assert.strictEqual($('.doc-title').textContent, 'TAX INVOICE');
  $('#saveInvoiceBtn').click();
  assert.strictEqual(Object.values(saved())[0].vatInclusive, true);
  $('#newInvoiceBtn').click();
  assert.ok($('#vatInclusive').checked);
  assert.strictEqual(d.querySelectorAll('#itemsBody tr').length, 1);
  type('#vatToggle', false); // inclusive only counts while VAT is on
  type(d.querySelector('.item-price'), '115');
  assert.match($('#grandTotal').textContent, /115[,.]00/);
  assert.strictEqual($('#totalLabel').textContent, 'Total due');
  assert.ok($('#netRow').hidden);
});

test('per-line VAT category changes VAT, marks the line for print, saves and restores', () => {
  const { $, d, type, saved } = boot();
  $('#addItem').click();
  const rows = () => [...d.querySelectorAll('#itemsBody tr')];
  rows().forEach(tr => type(tr.querySelector('.item-price'), '100'));
  type('#vatToggle', true);
  assert.match($('#vatAmount').textContent, /30[,.]00/);
  assert.ok(rows().every(tr => tr.querySelector('.item-vatcat').value === 'standard'));
  type(rows()[1].querySelector('.item-vatcat'), 'zero');
  assert.match($('#vatAmount').textContent, /15[,.]00/);
  assert.match($('#grandTotal').textContent, /215[,.]00/);
  assert.strictEqual(rows()[1].querySelector('.vat-mark').textContent, 'Zero-rated');
  assert.strictEqual(rows()[0].querySelector('.vat-mark').textContent, '');
  // mixed: standard and zero-rated rows shown, exempt (nil) not
  assert.ok(!$('#catStandardRow').hidden && !$('#catZeroRow').hidden && $('#catExemptRow').hidden);
  assert.strictEqual($('#catStandardLabel').textContent, 'Standard-rated (15%)');
  assert.ok(!$('#netRow').hidden);
  $('#saveInvoiceBtn').click();
  assert.deepStrictEqual(Object.values(saved())[0].items.map(i => i.vatCat), ['standard', 'zero']);
  $('#newInvoiceBtn').click();
  assert.strictEqual(d.querySelector('.item-vatcat').value, 'standard');
  assert.ok($('#catZeroRow').hidden);
  d.querySelector('.ledger-row').click();
  assert.deepStrictEqual(rows().map(tr => tr.querySelector('.item-vatcat').value), ['standard', 'zero']);
  assert.match($('#grandTotal').textContent, /215[,.]00/);
  type(rows()[1].querySelector('.item-vatcat'), 'exempt');
  assert.strictEqual(rows()[1].querySelector('.vat-mark').textContent, 'VAT exempt');
  type(rows()[0].querySelector('.item-vatcat'), 'exempt'); // exempt only: no VAT, no breakdown
  assert.match($('#vatAmount').textContent, /0[,.]00/);
  assert.match($('#grandTotal').textContent, /200[,.]00/);
  assert.ok($('#catExemptRow').hidden);
  type('#vatToggle', false); // categories and print marks only apply with VAT on
  assert.strictEqual(d.body.dataset.vat, 'off');
  assert.strictEqual(rows()[1].querySelector('.vat-mark').textContent, '');
  assert.ok($('#vatRow').classList.contains('vat-off'));
});

test('old saved VAT invoice opens with prices excl. VAT, every line standard, same total', () => {
  const old = inv('INV-0008', { vatToggle: true, items: [{ desc: 'Work', qty: '2', price: '100' }, { desc: 'More', qty: '1', price: '50' }] });
  const { $, d } = boot({ seed: { 'invoice-list': { 'INV-0008': old }, 'invoice-draft': { ...old, vatInclusive: true } } });
  assert.match(d.querySelector('.ledger-amount').textContent, /287[,.]50/);
  d.querySelector('.ledger-row').click();
  assert.ok(!$('#vatInclusive').checked);
  assert.ok([...d.querySelectorAll('.item-vatcat')].every(s => s.value === 'standard'));
  assert.match($('#grandTotal').textContent, /287[,.]50/);
  assert.ok($('#catStandardRow').hidden && $('#catZeroRow').hidden && $('#catExemptRow').hidden);
});

test('ledger total matches the sheet for an inclusive, mixed, discounted invoice', () => {
  const { $, d, type } = boot();
  $('#addItem').click();
  $('#addItem').click();
  const rows = [...d.querySelectorAll('#itemsBody tr')];
  [['3', '33.33', 'standard'], ['1', '99.99', 'zero'], ['2', '1.99', 'exempt']].forEach(([qty, price, cat], i) => {
    type(rows[i].querySelector('.item-qty'), qty);
    type(rows[i].querySelector('.item-price'), price);
    type(rows[i].querySelector('.item-vatcat'), cat);
  });
  type('#vatToggle', true);
  type('#vatInclusive', true);
  type('#discountValue', '7');
  $('#saveInvoiceBtn').click();
  const onScreen = $('#grandTotal').textContent;
  assert.strictEqual(d.querySelector('.ledger-amount').textContent, onScreen);
  // 99.99 + 99.99 + 3.98 = 203.96 incl., less 7% (14.28) = 189.68
  assert.match(onScreen, /189[,.]68/);
  assert.ok(!$('#catStandardRow').hidden && !$('#catZeroRow').hidden && !$('#catExemptRow').hidden);
});
