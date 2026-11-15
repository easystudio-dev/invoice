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

// Fills the first line with R1000, saves it and adds payments through the real form.
function payFixture(extra = {}) {
  const t = boot(extra);
  t.type(t.d.querySelector('.item-price'), '1000');
  t.type('#toName', 'Client');
  t.$('#saveInvoiceBtn').click();
  return t;
}
const addPay = ({ $, type }, amount, note = '') => { type('#payAmount', amount); type('#payNote', note); $('#addPaymentBtn').click(); };

test('payments: Paid and Balance due rows, ledger balance, save and restore', () => {
  const t = payFixture();
  const { $, d, saved } = t;
  assert.ok($('#paidRow').hidden && $('#balanceRow').hidden);
  addPay(t, '200', 'Deposit');
  addPay(t, '300', 'EFT');
  assert.ok(!$('#paidRow').hidden && !$('#balanceRow').hidden);
  assert.match($('#paidAmount').textContent, /-R\s*500[,.]00/);
  assert.match($('#balanceAmount').textContent, /500[,.]00/);
  assert.strictEqual(d.querySelectorAll('#paymentList li').length, 2);
  assert.match(d.querySelector('#paymentList li').textContent, /Deposit/);
  // saved copy updated at once (the invoice is open), ledger shows balance of total and Part paid
  const num = $('#invNumber').value;
  assert.strictEqual(saved()[num].payments.length, 2);
  assert.match(d.querySelector('.ledger-amount').textContent, /500[,.]00.*of.*1.?000[,.]00/);
  assert.strictEqual(d.querySelector('.ledger-status').textContent, 'Part paid');
  assert.strictEqual(d.querySelector('.ledger-row').dataset.status, 'part paid');
  assert.ok($('#stamp').hidden); // no PART PAID stamp
  // restore
  $('#newInvoiceBtn').click();
  assert.strictEqual(d.querySelectorAll('#paymentList li').length, 0);
  d.querySelector('.ledger-row').click();
  assert.strictEqual(d.querySelectorAll('#paymentList li').length, 2);
  assert.match($('#balanceAmount').textContent, /500[,.]00/);
});

test('payments: blank or invalid amount is rejected; remove button updates totals and saved copy', () => {
  const t = payFixture();
  const { $, d, saved, w } = t;
  addPay(t, '');
  addPay(t, '-5');
  assert.strictEqual(d.querySelectorAll('#paymentList li').length, 0);
  assert.ok($('#paymentMsg').textContent);
  addPay(t, '250');
  addPay(t, '100');
  assert.match($('#balanceAmount').textContent, /650[,.]00/);
  const btn = d.querySelector('#paymentList li .del-row');
  assert.match(btn.getAttribute('aria-label'), /Remove payment of/);
  btn.click();
  assert.match($('#balanceAmount').textContent, /900[,.]00/);
  assert.strictEqual(saved()[$('#invNumber').value].payments.length, 1);
  d.querySelector('#paymentList li .del-row').click();
  assert.ok($('#paidRow').hidden);
  assert.strictEqual(w.alerts.length, 0);
});

test('payments covering the total make the invoice Paid with a stamp; overpayment shows a zero balance', () => {
  const t = payFixture();
  const { $, d } = t;
  addPay(t, '600');
  addPay(t, '400');
  assert.strictEqual($('#stamp').textContent, 'Paid');
  assert.match($('#balanceAmount').textContent, /0[,.]00/);
  assert.strictEqual(d.querySelector('.ledger-status').textContent, 'Paid');
  assert.match(d.querySelector('.ledger-amount').textContent, /^R\s*1.?000[,.]00$/);
  addPay(t, '50'); // overpay
  assert.match($('#balanceAmount').textContent, /^R\s*0[,.]00$/);
  assert.strictEqual($('#stamp').textContent, 'Paid');
});

test('overdue invoice with a part payment stays Overdue and the ledger still shows the balance', () => {
  const t = payFixture();
  t.type('#terms', 'custom');
  t.type('#dueDate', '2020-01-01');
  t.$('#saveInvoiceBtn').click();
  addPay(t, '100');
  assert.strictEqual(t.$('#stamp').textContent, 'Overdue');
  assert.strictEqual(t.d.querySelector('.ledger-status').textContent, 'Overdue');
  assert.match(t.d.querySelector('.ledger-amount').textContent, /900[,.]00.*of/);
});

test('New invoice, switching type and Convert do not carry payments', () => {
  const t = payFixture();
  const { $, d } = t;
  addPay(t, '100');
  $('#newInvoiceBtn').click();
  assert.strictEqual(d.querySelectorAll('#paymentList li').length, 0);
  assert.ok($('#paidRow').hidden);
  d.querySelector('.ledger-row').click();
  t.type('#docType', 'quote');
  assert.strictEqual(d.querySelectorAll('#paymentList li').length, 0);
  assert.ok($('#paidRow').hidden);
  assert.strictEqual(JSON.parse(t.w.localStorage.getItem('invoice-draft')).payments.length, 0);
});

test('Convert from a saved quote marks that quote accepted; the new invoice has no payments or quote status', () => {
  const quote = inv('QUO-0001', { docType: 'quote', dueDate: '2020-01-01', payments: [{ amount: '5' }] });
  const { $, d, saved } = boot({ seed: { 'invoice-list': { 'QUO-0001': quote } } });
  d.querySelector('.ledger-row').click();
  assert.strictEqual(d.querySelector('.ledger-status').textContent, 'Expired');
  $('#convertBtn').click();
  assert.strictEqual(saved()['QUO-0001'].quoteStatus, 'accepted');
  assert.strictEqual(saved()['QUO-0001'].docType, 'quote');
  assert.strictEqual($('#docType').value, 'invoice');
  assert.strictEqual($('#quoteStatus').value, '');
  assert.strictEqual(d.querySelectorAll('#paymentList li').length, 0);
  assert.strictEqual(Object.keys(saved()).length, 1);
  assert.ok([...d.querySelectorAll('.ledger-row')].some(r => r.querySelector('.ledger-status').textContent === 'Accepted'));
});

test('Convert from an unsaved quote does not touch a saved quote with the same number', () => {
  const { $, d, type, saved } = boot({ seed: { 'invoice-list': { 'QUO-0001': inv('QUO-0001', { docType: 'quote' }) } } });
  type('#docType', 'quote');
  type('#invNumber', 'QUO-0001');
  $('#convertBtn').click();
  assert.strictEqual(saved()['QUO-0001'].quoteStatus, undefined);
});

test('quote status on an opened saved quote updates its saved copy, the stamp and the ledger', () => {
  const quote = inv('QUO-0002', { docType: 'quote', dueDate: '2020-01-01' });
  const { $, d, type, saved } = boot({ seed: { 'invoice-list': { 'QUO-0002': quote } } });
  d.querySelector('.ledger-row').click();
  assert.strictEqual($('#stamp').textContent, 'Expired');
  type('#quoteStatus', 'accepted');
  assert.strictEqual(saved()['QUO-0002'].quoteStatus, 'accepted');
  assert.strictEqual($('#stamp').textContent, 'Accepted'); // beats Expired
  assert.strictEqual(d.querySelector('.ledger-status').textContent, 'Accepted');
  type('#quoteStatus', 'declined');
  assert.strictEqual(saved()['QUO-0002'].quoteStatus, 'declined');
  assert.strictEqual($('#stamp').textContent, 'Declined');
  d.querySelector('.ledger-row').click(); // restores from the saved copy
  assert.strictEqual($('#quoteStatus').value, 'declined');
  $('#newInvoiceBtn').click();
  assert.strictEqual($('#quoteStatus').value, '');
});

test('quote status on an unsaved quote leaves saved quotes alone', () => {
  const { $, type, saved } = boot({ seed: { 'invoice-list': { 'QUO-0002': inv('QUO-0002', { docType: 'quote' }) } } });
  type('#docType', 'quote');
  type('#invNumber', 'QUO-0002');
  type('#quoteStatus', 'declined');
  assert.strictEqual(saved()['QUO-0002'].quoteStatus, undefined);
});

test('old saved invoice and quote without payments / quoteStatus open cleanly', () => {
  const { $, d, w } = boot({ seed: { 'invoice-list': { 'INV-0001': inv('INV-0001'), 'QUO-0001': inv('QUO-0001', { docType: 'quote' }) } } });
  // dirty the form first: nothing from it may leak into the old saves
  d.querySelectorAll('.ledger-row').forEach(row => {
    row.click();
    assert.strictEqual(d.querySelectorAll('#paymentList li').length, 0);
    assert.ok($('#paidRow').hidden);
    assert.strictEqual($('#quoteStatus').value, '');
  });
  assert.strictEqual(w.alerts.length, 0);
});

test('payment data from an imported file is shown as text, not markup', () => {
  const evil = inv('INV-0009', { payments: [{ date: '2026-01-02', amount: '5', note: '<img src=x onerror=alert(1)>' }, null, 'junk'] });
  const { d } = boot({ seed: { 'invoice-list': { 'INV-0009': evil } } });
  d.querySelector('.ledger-row').click();
  assert.strictEqual(d.querySelectorAll('#paymentList img').length, 0);
  assert.strictEqual(d.querySelectorAll('#paymentList li').length, 1);
});

// --- Credit notes ---
// A saved VAT invoice, R100 + R50 standard-rated + 15% = R172.50, opened from the ledger.
function creditFixture(extra = {}, seed = {}) {
  const original = inv('INV-0003', { vatToggle: true, vatRate: '15', fromName: 'Me Studio', fromDetails: 'Cape Town', toName: 'Client',
    toDetails: '1 Main Rd', toEmail: 'c@example.com', currency: 'ZAR', dueDate: '2099-01-01', terms: '7',
    items: [{ desc: 'Design', qty: '1', unit: 'job', price: '100', vatCat: 'standard' }, { desc: 'Print', qty: '1', price: '50', vatCat: 'standard' }], ...extra });
  const t = boot({ seed: { 'invoice-list': { 'INV-0003': original, ...seed } } });
  const row = num => [...t.d.querySelectorAll('.ledger-row')].find(r => r.querySelector('.ledger-num').textContent === num);
  row('INV-0003').click();
  return { ...t, row };
}
const today = () => require('./lib.js').localISODate(new Date());

test('credit note from a saved invoice copies it, numbers CN-0001, shows the reference and hides the due date', () => {
  const { $, d, type, saved, w } = creditFixture({ vatInclusive: true, currency: 'USD',
    items: [{ desc: 'Design', qty: '2', unit: 'hrs', price: '100', vatCat: 'standard' }, { desc: 'Books', qty: '1', price: '50', vatCat: 'zero' }] });
  assert.ok(!$('#creditNoteBtn').hidden);
  $('#creditNoteBtn').click();
  assert.strictEqual($('#docType').value, 'credit');
  assert.strictEqual(d.body.dataset.doc, 'credit');
  assert.strictEqual($('#invNumber').value, 'CN-0001');
  assert.strictEqual($('#invDate').value, today());
  assert.strictEqual($('#creditRef').textContent, 'Credit note for invoice INV-0003');
  assert.ok($('#dueRow').hidden);
  assert.strictEqual($('#dueDate').value, '');
  assert.strictEqual($('.doc-title').textContent, 'CREDIT NOTE'); // VAT on: still not "tax credit note"
  assert.strictEqual($('label[for=invNumber]').textContent, 'Credit note #');
  assert.strictEqual($('#newInvoiceBtn').textContent, 'New credit note');
  assert.strictEqual($('#creditReason').value, '');
  assert.strictEqual(d.activeElement, $('#creditReason'));
  // copied: parties, currency, VAT settings, lines with their categories
  assert.strictEqual($('#fromName').value, 'Me Studio');
  assert.strictEqual($('#toName').value, 'Client');
  assert.strictEqual($('#toDetails').value, '1 Main Rd');
  assert.strictEqual($('#currency').value, 'USD');
  assert.ok($('#vatToggle').checked && $('#vatInclusive').checked);
  assert.strictEqual($('#vatRate').value, '15');
  assert.deepStrictEqual([...d.querySelectorAll('.item-desc')].map(t => t.value), ['Design', 'Books']);
  assert.deepStrictEqual([...d.querySelectorAll('.item-vatcat')].map(s => s.value), ['standard', 'zero']);
  assert.strictEqual($('.item-unit').value, 'hrs');
  assert.match($('#grandTotal').textContent, /250\.00/); // positive, same total as the invoice
  assert.strictEqual($('#totalLabel').textContent, 'Total credit incl. VAT');
  assert.ok($('#paidRow').hidden && $('#creditedRow').hidden && $('#balanceRow').hidden);
  assert.ok($('#stamp').hidden);
  // unsaved: nothing new in the list, Credit note / Delete gone
  assert.deepStrictEqual(Object.keys(saved()), ['INV-0003']);
  assert.ok($('#creditNoteBtn').hidden && $('#deleteInvoiceBtn').hidden);
  type('#vatToggle', false);
  assert.strictEqual($('.doc-title').textContent, 'CREDIT NOTE');
  assert.strictEqual($('#totalLabel').textContent, 'Total credit');
  $('#printBtn').click();
  assert.strictEqual(d.title, 'Credit note CN-0001 - Client');
  assert.strictEqual(w.alerts.length, 0);
});

test('credit note needs a reason; saved with its reference and reason', () => {
  const { $, type, saved, w } = creditFixture();
  $('#creditNoteBtn').click();
  $('#saveInvoiceBtn').click();
  assert.strictEqual(w.alerts.length, 1);
  assert.match(w.alerts[0], /reason/i);
  assert.ok(!saved()['CN-0001']);
  type('#creditReason', '   ');
  $('#saveInvoiceBtn').click();
  assert.ok(!saved()['CN-0001']);
  type('#creditReason', 'Print job cancelled');
  $('#saveInvoiceBtn').click();
  const cn = saved()['CN-0001'];
  assert.strictEqual(cn.docType, 'credit');
  assert.strictEqual(cn.creditFor, 'INV-0003');
  assert.strictEqual(cn.creditReason, 'Print job cancelled');
  assert.strictEqual(cn.dueDate, '');
  assert.strictEqual(w.alerts.length, 2);
  assert.strictEqual(saved()['INV-0003'].docType, 'invoice'); // the original is untouched
});

test('credit note over what is left on the invoice is blocked', () => {
  const { $, d, type, saved, w, row } = creditFixture();
  $('#creditNoteBtn').click();
  type('#creditReason', 'Overcharged');
  type(d.querySelector('.item-price'), '101'); // 151 + VAT = 173.65 > 172.50
  $('#saveInvoiceBtn').click();
  assert.strictEqual(w.alerts.length, 1);
  assert.match(w.alerts[0], /more than is left to credit on invoice INV-0003/);
  assert.ok(!saved()['CN-0001']);
  d.querySelectorAll('.del-row')[1].click(); // credit just the R100 line: 115
  type(d.querySelector('.item-price'), '100');
  $('#saveInvoiceBtn').click();
  assert.ok(saved()['CN-0001']);
  // a second credit note may only take the remaining 57.50
  row('INV-0003').click();
  $('#creditNoteBtn').click();
  assert.strictEqual($('#invNumber').value, 'CN-0002');
  type('#creditReason', 'Again');
  $('#saveInvoiceBtn').click();
  assert.strictEqual(w.alerts.length, 2);
  assert.ok(!saved()['CN-0002']);
  d.querySelectorAll('.del-row')[0].click(); // the R50 line only: 57.50, exactly what's left
  $('#saveInvoiceBtn').click();
  assert.ok(saved()['CN-0002']);
  assert.strictEqual(w.alerts.length, 2);
  // re-saving the opened CN-0001 doesn't count its own old copy
  row('CN-0001').click();
  type('#creditReason', 'Overcharged on design');
  $('#saveInvoiceBtn').click();
  assert.strictEqual(saved()['CN-0001'].creditReason, 'Overcharged on design');
  assert.strictEqual(w.alerts.length, 2);
});

test('saving a credit note lowers the invoice balance in the ledger and on its sheet; full credit is Credited', () => {
  const { $, d, type, w, row } = creditFixture();
  $('#creditNoteBtn').click();
  type('#creditReason', 'Print cancelled');
  d.querySelectorAll('.del-row')[0].click(); // credit the R50 line: 57.50
  $('#saveInvoiceBtn').click();
  assert.match(row('CN-0001').querySelector('.ledger-amount').textContent, /^-R\s*57[,.]50$/);
  assert.strictEqual(row('CN-0001').querySelector('.ledger-status').textContent, 'Credit for INV-0003');
  assert.strictEqual(row('CN-0001').dataset.status, 'credit');
  assert.match(row('INV-0003').querySelector('.ledger-amount').textContent, /115[,.]00.*of.*172[,.]50/);
  // the original's sheet: Credited row under Paid, balance accounts for it, no stamp
  row('INV-0003').click();
  assert.ok(!$('#creditedRow').hidden && !$('#balanceRow').hidden && $('#paidRow').hidden);
  assert.match($('#creditedAmount').textContent, /-R\s*57[,.]50/);
  assert.match($('#balanceAmount').textContent, /115[,.]00/);
  assert.ok($('#stamp').hidden);
  // credit + payment covering the rest: Paid
  addPay({ $, type }, '100');
  assert.strictEqual(row('INV-0003').querySelector('.ledger-status').textContent, 'Part paid');
  addPay({ $, type }, '15');
  assert.strictEqual($('#stamp').textContent, 'Paid');
  assert.strictEqual(row('INV-0003').querySelector('.ledger-status').textContent, 'Paid');
  // full credit on its own: Credited
  d.querySelectorAll('#paymentList .del-row')[0].click();
  d.querySelectorAll('#paymentList .del-row')[0].click();
  $('#creditNoteBtn').click();
  type('#creditReason', 'Design cancelled too');
  d.querySelectorAll('.del-row')[1].click(); // the R100 line: 115
  $('#saveInvoiceBtn').click();
  assert.strictEqual(row('INV-0003').querySelector('.ledger-status').textContent, 'Credited');
  assert.strictEqual(row('INV-0003').dataset.status, 'credited');
  assert.match(row('INV-0003').querySelector('.ledger-amount').textContent, /^R\s*172[,.]50$/);
  row('INV-0003').click();
  assert.strictEqual($('#stamp').textContent, 'Credited');
  assert.match($('#balanceAmount').textContent, /^R\s*0[,.]00$/);
  assert.strictEqual(w.alerts.length, 0);
});

test('credit notes for another invoice do not touch this one', () => {
  const other = inv('INV-0001');
  const cn = inv('CN-0001', { docType: 'credit', creditFor: 'INV-0001', creditReason: 'x', items: [{ qty: '1', price: '100' }] });
  const { $, row } = creditFixture({}, { 'INV-0001': other, 'CN-0001': cn });
  assert.ok($('#creditedRow').hidden);
  assert.match(row('INV-0003').querySelector('.ledger-amount').textContent, /^R\s*172[,.]50$/);
  assert.strictEqual(row('INV-0001').querySelector('.ledger-status').textContent, 'Credited');
});

test('Credit note button only for a saved invoice, not drafts, quotes or credit notes', () => {
  const quote = inv('QUO-0001', { docType: 'quote' });
  const cn = inv('CN-0001', { docType: 'credit', creditFor: 'INV-0003', creditReason: 'x', items: [{ qty: '1', price: '10' }] });
  const { $, type, row } = creditFixture({}, { 'QUO-0001': quote, 'CN-0001': cn });
  assert.ok(!$('#creditNoteBtn').hidden);
  $('#newInvoiceBtn').click();
  assert.ok($('#creditNoteBtn').hidden); // unsaved draft
  row('QUO-0001').click();
  assert.ok($('#creditNoteBtn').hidden);
  row('CN-0001').click();
  assert.ok($('#creditNoteBtn').hidden);
  assert.strictEqual($('#creditRef').textContent, 'Credit note for invoice INV-0003');
  row('INV-0003').click();
  type('#docType', 'quote');
  assert.ok($('#creditNoteBtn').hidden);
});

test('fresh app: no Credit note button; choosing Credit note type on a saved invoice credits it', () => {
  const fresh = boot();
  assert.ok(fresh.$('#creditNoteBtn').hidden);
  const { $, type } = creditFixture();
  type('#docType', 'credit');
  assert.strictEqual($('#invNumber').value, 'CN-0001');
  assert.strictEqual($('#creditRef').textContent, 'Credit note for invoice INV-0003');
  assert.strictEqual($('#toName').value, 'Client');
});

test('a credit note not linked to an invoice cannot be saved', () => {
  const { $, type, saved, w } = boot();
  type('#docType', 'credit');
  assert.strictEqual($('#invNumber').value, 'CN-0001');
  type('#creditReason', 'Returned');
  type($('.item-price'), '10');
  $('#saveInvoiceBtn').click();
  assert.match(w.alerts[0], /must be for a saved invoice/);
  assert.deepStrictEqual(saved(), {});
});

test('deleting an invoice with credit notes warns and keeps them', () => {
  const cn = inv('CN-0001', { docType: 'credit', creditFor: 'INV-0003', creditReason: 'x', items: [{ qty: '1', price: '10' }] });
  const { $, w, saved } = creditFixture({}, { 'CN-0001': cn });
  let asked = '';
  w.confirm = msg => { asked = msg; return true; };
  $('#deleteInvoiceBtn').click();
  assert.match(asked, /credit note \(CN-0001\) will stay saved, pointing at a deleted invoice/);
  assert.deepStrictEqual(Object.keys(saved()), ['CN-0001']);
});

test('old saved invoice without credit fields opens cleanly', () => {
  const { $, d, w } = boot({ seed: { 'invoice-list': { 'INV-0001': inv('INV-0001') } } });
  d.querySelector('.ledger-row').click();
  assert.strictEqual($('#docType').value, 'invoice');
  assert.strictEqual($('#creditReason').value, '');
  assert.ok($('#creditedRow').hidden && $('#balanceRow').hidden);
  assert.ok(!$('#creditNoteBtn').hidden && !$('#dueRow').hidden);
  assert.strictEqual($('.doc-title').textContent, 'INVOICE');
  assert.strictEqual(d.querySelector('.ledger-status').textContent, '');
  assert.strictEqual(w.alerts.length, 0);
});
