const test = require('node:test');
const assert = require('node:assert');
const { localISODate, addDays, safeParse, round2, vatCategory, invoiceTotals, nextInvoiceNumber, nextNumberAfter, nextFreeNumber, paymentsTotal, balanceDue, invoiceStatus } = require('./lib.js');

// The fields invoiceTotals returned before VAT categories existed (it now also returns `categories`).
const legacy = ({ lineTotals, subtotal, discount, net, vat, total }) => ({ lineTotals, subtotal, discount, net, vat, total });

test('invoiceStatus: paid wins, overdue only after the due date', () => {
  assert.strictEqual(invoiceStatus({ paid: true, dueDate: '2026-01-01' }, '2026-10-21'), 'Paid');
  assert.strictEqual(invoiceStatus({ paid: false, dueDate: '2026-10-20' }, '2026-10-21'), 'Overdue');
  assert.strictEqual(invoiceStatus({ paid: false, dueDate: '2026-10-21' }, '2026-10-21'), '');
  assert.strictEqual(invoiceStatus({ dueDate: '' }, '2026-10-21'), '');
});

test('invoiceStatus: quotes expire instead of going overdue, and are never paid', () => {
  assert.strictEqual(invoiceStatus({ docType: 'quote', dueDate: '2026-10-20' }, '2026-10-21'), 'Expired');
  assert.strictEqual(invoiceStatus({ docType: 'quote', dueDate: '2026-10-21', paid: true }, '2026-10-21'), '');
});

test('paymentsTotal sums valid positive amounts to the cent and ignores junk', () => {
  assert.strictEqual(paymentsTotal([{ amount: '0.1' }, { amount: 0.2 }, { amount: '' }, { amount: 'abc' }, { amount: '-5' }, null, {}]), 0.3);
  assert.strictEqual(paymentsTotal(undefined), 0);
  assert.strictEqual(paymentsTotal('nope'), 0);
});

test('balanceDue rounds to cents and never goes below zero', () => {
  assert.strictEqual(balanceDue(1000, [{ amount: '500' }]), 500);
  assert.strictEqual(balanceDue(100.1, [{ amount: '0.2' }]), 99.9);
  assert.strictEqual(balanceDue(1000, [{ amount: '1000' }]), 0);
  assert.strictEqual(balanceDue(1000, [{ amount: '1200' }]), 0); // overpayment
  assert.strictEqual(balanceDue(1000), 1000);
});

test('invoiceStatus with payments: paid in full, part paid, overdue wins over part paid', () => {
  const due = '2026-10-21', today = '2026-10-21', late = '2026-10-20';
  const pay = (...amounts) => amounts.map(amount => ({ amount }));
  assert.strictEqual(invoiceStatus({ dueDate: due, payments: pay('500') }, today, 1000), 'Part paid');
  assert.strictEqual(invoiceStatus({ dueDate: due, payments: pay('400', '600') }, today, 1000), 'Paid'); // equal to total
  assert.strictEqual(invoiceStatus({ dueDate: due, payments: pay('1200') }, today, 1000), 'Paid'); // overpayment
  assert.strictEqual(invoiceStatus({ dueDate: late, payments: pay('500') }, today, 1000), 'Overdue');
  assert.strictEqual(invoiceStatus({ dueDate: late, payments: pay('1000') }, today, 1000), 'Paid');
  assert.strictEqual(invoiceStatus({ dueDate: late, paid: true, payments: pay('1') }, today, 1000), 'Paid'); // tick wins
  assert.strictEqual(invoiceStatus({ dueDate: due, paid: true, payments: [] }, today, 1000), 'Paid');
  assert.strictEqual(invoiceStatus({ dueDate: due, payments: pay('', 'x') }, today, 1000), ''); // junk payments
  assert.strictEqual(invoiceStatus({ dueDate: due, payments: pay('99.999') }, today, 100), 'Paid'); // to the cent
  assert.strictEqual(invoiceStatus({ dueDate: due, payments: pay('99.99') }, today, 100), 'Part paid');
  assert.strictEqual(invoiceStatus({ dueDate: due, payments: pay('50') }, today), 'Part paid'); // no total given
  assert.strictEqual(invoiceStatus({ dueDate: due, payments: [] }, today, 0), ''); // nothing received on a zero total
});

test('invoiceStatus for quotes: accepted / declined beat expired; payments are ignored', () => {
  const quote = extra => ({ docType: 'quote', dueDate: '2026-10-20', ...extra });
  assert.strictEqual(invoiceStatus(quote({ quoteStatus: 'accepted' }), '2026-10-21'), 'Accepted');
  assert.strictEqual(invoiceStatus(quote({ quoteStatus: 'declined' }), '2026-10-21'), 'Declined');
  assert.strictEqual(invoiceStatus(quote({ quoteStatus: '' }), '2026-10-21'), 'Expired');
  assert.strictEqual(invoiceStatus(quote({ quoteStatus: 'accepted', dueDate: '2026-12-01' }), '2026-10-21'), 'Accepted');
  assert.strictEqual(invoiceStatus(quote({ dueDate: '2026-12-01', payments: [{ amount: '5' }] }), '2026-10-21', 1), '');
});

test('invoiceStatus: records saved before payments / quoteStatus existed behave as before', () => {
  assert.strictEqual(invoiceStatus({ paid: false, dueDate: '2026-10-20' }, '2026-10-21', 100), 'Overdue');
  assert.strictEqual(invoiceStatus({ paid: false, dueDate: '2026-12-01' }, '2026-10-21', 100), '');
  assert.strictEqual(invoiceStatus({ docType: 'quote', dueDate: '2026-12-01' }, '2026-10-21', 100), '');
  assert.strictEqual(invoiceStatus({ paid: true }, '2026-10-21', 100), 'Paid');
});

test('nextNumberAfter continues from the highest number', () => {
  assert.strictEqual(nextNumberAfter(['INV-0002', 'INV-0010', 'INV-0009'], 'INV-0001'), 'INV-0011');
  assert.strictEqual(nextNumberAfter([], 'QUO-0001'), 'QUO-0001');
});

test('nextFreeNumber never reuses a saved number', () => {
  const list = {
    'INV-0003': {}, 'INV-0004': { docType: 'invoice' }, 'QUO-0001': { docType: 'quote' },
  };
  // New from old INV-0003: skips past the saved INV-0004
  assert.strictEqual(nextFreeNumber(list, 'invoice', 'INV-0003'), 'INV-0005');
  // Unsaved draft ahead of the saved ones keeps its own sequence
  assert.strictEqual(nextFreeNumber(list, 'invoice', 'INV-0010'), 'INV-0011');
  // Quotes count only quotes
  assert.strictEqual(nextFreeNumber(list, 'quote'), 'QUO-0002');
  assert.strictEqual(nextFreeNumber({}, 'quote'), 'QUO-0001');
  // Fallback number already taken by a document of the other type
  assert.strictEqual(nextFreeNumber({ 'INV-0001': { docType: 'quote' } }, 'invoice'), 'INV-0002');
});

test('round2 rounds half away from zero despite float error', () => {
  assert.strictEqual(round2(1.005), 1.01);
  assert.strictEqual(round2(-1.005), -1.01);
  assert.strictEqual(round2(0.1 * 3), 0.3);
  assert.strictEqual(round2(1234567.125), 1234567.13);
});

test('invoiceTotals sums rounded lines and rounds VAT', () => {
  const items = [{ qty: '1', price: '0.333' }, { qty: '1', price: '0.333' }, { qty: '1', price: '0.333' }];
  // lines show 0.33 each, so subtotal must be 0.99 (not 1.00 from summing raw floats)
  assert.deepStrictEqual(legacy(invoiceTotals(items, 15)), { lineTotals: [0.33, 0.33, 0.33], subtotal: 0.99, discount: 0, net: 0.99, vat: 0.15, total: 1.14 });
  assert.deepStrictEqual(legacy(invoiceTotals([{ qty: '', price: 'x' }], 0)), { lineTotals: [0], subtotal: 0, discount: 0, net: 0, vat: 0, total: 0 });
  assert.strictEqual(invoiceTotals([{ qty: 2, price: 100 }, { qty: 1, price: -50 }], 15).total, 172.5);
});

test('nextInvoiceNumber bumps the last number and keeps padding', () => {
  assert.strictEqual(nextInvoiceNumber('INV-0001'), 'INV-0002');
  assert.strictEqual(nextInvoiceNumber('INV-0099'), 'INV-0100');
  assert.strictEqual(nextInvoiceNumber('2026-INV-9'), '2026-INV-10');
  assert.strictEqual(nextInvoiceNumber('ABC'), 'ABC-2');
  assert.strictEqual(nextInvoiceNumber(''), 'INV-0001');
});

test('localISODate uses local calendar day, not UTC', () => {
  // 00:30 local time: toISOString() would roll back a day east of UTC
  assert.strictEqual(localISODate(new Date(2026, 9, 21, 0, 30)), '2026-10-21');
  assert.strictEqual(localISODate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('addDays adds to an ISO date and crosses month/year', () => {
  assert.strictEqual(addDays('2026-10-21', 7), '2026-10-28');
  assert.strictEqual(addDays('2026-12-28', 7), '2027-01-04');
  assert.strictEqual(addDays('2026-10-21', 0), '2026-10-21');
});

test('safeParse returns fallback on bad JSON or null', () => {
  assert.deepStrictEqual(safeParse('{"a":1}', {}), { a: 1 });
  assert.deepStrictEqual(safeParse('{oops', {}), {});
  assert.strictEqual(safeParse(null, null), null);
  assert.deepStrictEqual(safeParse('null', {}), {});
});

const lines = [{ qty: '2', price: '100' }, { qty: '1', price: '50' }]; // subtotal 250

test('invoiceTotals without a discount keeps the old results and adds zero discount', () => {
  assert.deepStrictEqual(legacy(invoiceTotals(lines, 15)),
    { lineTotals: [200, 50], subtotal: 250, discount: 0, net: 250, vat: 37.5, total: 287.5 });
});

test('invoiceTotals: percent discount', () => {
  const t = invoiceTotals(lines, 0, { type: 'percent', value: '10' });
  assert.strictEqual(t.discount, 25);
  assert.strictEqual(t.net, 225);
  assert.strictEqual(t.total, 225);
});

test('invoiceTotals: fixed amount discount, rounded to cents', () => {
  assert.strictEqual(invoiceTotals(lines, 0, { type: 'amount', value: 40 }).discount, 40);
  assert.strictEqual(invoiceTotals(lines, 0, { type: 'amount', value: '12.345' }).discount, 12.35);
});

test('invoiceTotals: discount is clamped to the subtotal and never negative', () => {
  const over = invoiceTotals(lines, 15, { type: 'amount', value: 999 });
  assert.deepStrictEqual([over.discount, over.net, over.vat, over.total], [250, 0, 0, 0]);
  assert.strictEqual(invoiceTotals(lines, 0, { type: 'percent', value: 150 }).discount, 250);
  assert.strictEqual(invoiceTotals(lines, 0, { type: 'amount', value: -20 }).discount, 0);
});

test('invoiceTotals: zero, blank or junk discount does nothing', () => {
  for (const value of [0, '', undefined, 'abc']) {
    const t = invoiceTotals(lines, 0, { type: 'percent', value });
    assert.strictEqual(t.discount, 0);
    assert.strictEqual(t.total, 250);
  }
  assert.strictEqual(invoiceTotals(lines, 0, { type: undefined, value: '' }).total, 250);
});

test('invoiceTotals: VAT is charged on the discounted amount', () => {
  const t = invoiceTotals(lines, 15, { type: 'percent', value: 20 }); // net 200, vat 30
  assert.deepStrictEqual([t.net, t.vat, t.total], [200, 30, 230]);
});

test('invoiceTotals: no discount on a negative subtotal', () => {
  const t = invoiceTotals([{ qty: '1', price: '-50' }], 0, { type: 'percent', value: 10 });
  assert.deepStrictEqual([t.subtotal, t.discount, t.total], [-50, 0, -50]);
});

// --- VAT-inclusive pricing, VAT categories, discount apportioning ---
const pick = (t, cat) => [t.categories[cat].net, t.categories[cat].vat, t.categories[cat].total];

test('inclusive: VAT is extracted, not added', () => {
  const t = invoiceTotals([{ qty: '1', price: '115' }], 15, undefined, { inclusive: true });
  assert.deepStrictEqual([t.subtotal, t.net, t.vat, t.total], [115, 100, 15, 115]);
  // R100 incl. at 15%: VAT 13.04 (100 × 15/115 = 13.043…), excl. 86.96
  const u = invoiceTotals([{ qty: '2', price: '50' }], 15, null, { inclusive: true });
  assert.deepStrictEqual([u.net, u.vat, u.total], [86.96, 13.04, 100]);
});

test('inclusive with a discount: total is the discounted lines, VAT extracted from it', () => {
  const t = invoiceTotals(lines, 15, { type: 'percent', value: 10 }, { inclusive: true }); // 250 − 25 = 225 incl.
  assert.deepStrictEqual([t.subtotal, t.discount, t.total, t.vat, t.net], [250, 25, 225, 29.35, 195.65]);
  const a = invoiceTotals([{ qty: 1, price: 115 }], 15, { type: 'amount', value: 23 }, { inclusive: true });
  assert.deepStrictEqual([a.total, a.vat, a.net], [92, 12, 80]);
});

test('inclusive is ignored at a 0% rate and when nothing is standard-rated', () => {
  const t = invoiceTotals(lines, 0, null, { inclusive: true });
  assert.deepStrictEqual(legacy(t), legacy(invoiceTotals(lines, 0)));
  const z = invoiceTotals([{ qty: 1, price: 100, vatCat: 'zero' }], 15, null, { inclusive: true });
  assert.deepStrictEqual([z.net, z.vat, z.total], [100, 0, 100]);
});

test('mixed categories: only standard-rated lines pay VAT', () => {
  const items = [
    { qty: '1', price: '1000' },
    { qty: '2', price: '150', vatCat: 'zero' },
    { qty: '1', price: '200', vatCat: 'exempt' },
  ];
  const t = invoiceTotals(items, 15);
  assert.deepStrictEqual([t.subtotal, t.net, t.vat, t.total], [1500, 1500, 150, 1650]);
  assert.deepStrictEqual(pick(t, 'standard'), [1000, 150, 1150]);
  assert.deepStrictEqual(pick(t, 'zero'), [300, 0, 300]);
  assert.deepStrictEqual(pick(t, 'exempt'), [200, 0, 200]);
  const inc = invoiceTotals(items, 15, null, { inclusive: true });
  assert.deepStrictEqual([inc.total, inc.vat, inc.net], [1500, 130.43, 1369.57]);
  assert.deepStrictEqual(pick(inc, 'standard'), [869.57, 130.43, 1000]);
});

test('mixed categories with a discount: apportioned pro rata, VAT on the discounted standard part', () => {
  const items = [{ qty: 1, price: 600 }, { qty: 1, price: 300, vatCat: 'zero' }, { qty: 1, price: 100, vatCat: 'exempt' }];
  const t = invoiceTotals(items, 15, { type: 'percent', value: 10 }); // 100 off: 60 / 30 / 10
  assert.deepStrictEqual(['standard', 'zero', 'exempt'].map(c => t.categories[c].discount), [60, 30, 10]);
  assert.deepStrictEqual(pick(t, 'standard'), [540, 81, 621]);
  assert.deepStrictEqual([t.net, t.vat, t.total], [900, 81, 981]);
  const inc = invoiceTotals(items, 15, { type: 'percent', value: 10 }, { inclusive: true });
  assert.deepStrictEqual(pick(inc, 'standard'), [469.57, 70.43, 540]);
  assert.deepStrictEqual([inc.net, inc.vat, inc.total], [829.57, 70.43, 900]);
});

test('discount apportioning puts the rounding remainder on the largest category', () => {
  // R1 off three equal R10 parts: 0.33 each leaves 0.01 over, which goes to the largest (first on a tie)
  const eq = [{ qty: 1, price: 10 }, { qty: 1, price: 10, vatCat: 'zero' }, { qty: 1, price: 10, vatCat: 'exempt' }];
  const t = invoiceTotals(eq, 15, { type: 'amount', value: 1 });
  assert.deepStrictEqual(['standard', 'zero', 'exempt'].map(c => t.categories[c].discount), [0.34, 0.33, 0.33]);
  // 10c off R1 / R1 / R2: 2.5c rounds up to 3c twice, 5c — 11c in all, so the largest (exempt) gives 1c back
  const un = [{ qty: 1, price: 1 }, { qty: 1, price: 1, vatCat: 'zero' }, { qty: 1, price: 2, vatCat: 'exempt' }];
  const u = invoiceTotals(un, 15, { type: 'amount', value: 0.1 });
  assert.deepStrictEqual(['standard', 'zero', 'exempt'].map(c => u.categories[c].discount), [0.03, 0.03, 0.04]);
  assert.deepStrictEqual(pick(u, 'standard'), [0.97, 0.15, 1.12]);
  assert.strictEqual(u.total, 4.05);
});

test('exempt-only and zero-rated-only invoices have no VAT', () => {
  for (const vatCat of ['exempt', 'zero']) {
    for (const inclusive of [false, true]) {
      const t = invoiceTotals([{ qty: 3, price: 99.99, vatCat }], 15, { type: 'percent', value: 5 }, { inclusive });
      assert.deepStrictEqual([t.vat, t.net, t.total], [0, 284.97, 284.97]);
    }
  }
});

test('vatCategory defaults missing or unknown values to standard', () => {
  assert.strictEqual(vatCategory({}), 'standard');
  assert.strictEqual(vatCategory({ vatCat: 'bogus' }), 'standard');
  assert.strictEqual(vatCategory({ vatCat: 'zero' }), 'zero');
  assert.strictEqual(vatCategory({ vatCat: 'exempt' }), 'exempt');
});

test('backward compatible: old signatures give the same numbers as before', () => {
  // The pre-category formula, inlined
  const before = (items, rate, discount) => {
    const lt = items.map(it => round2((parseFloat(it.qty) || 0) * (parseFloat(it.price) || 0)));
    const sub = round2(lt.reduce((a, b) => a + b, 0));
    const value = Math.max(0, parseFloat(discount && discount.value) || 0);
    const raw = discount && discount.type === 'amount' ? value : sub * value / 100;
    const off = Math.max(0, Math.min(round2(raw), sub));
    const net = round2(sub - off);
    const vat = round2(net * (rate || 0) / 100);
    return { lineTotals: lt, subtotal: sub, discount: off, net, vat, total: round2(net + vat) };
  };
  const sets = [lines, [{ qty: '1.5', price: '33.33' }, { qty: 1, price: -5 }], [{ qty: '', price: 'x' }], [{ qty: 7, price: 0.07 }]];
  for (const items of sets) {
    for (const rate of [0, 15, undefined]) {
      assert.deepStrictEqual(legacy(invoiceTotals(items, rate)), before(items, rate));
      for (const d of [{ type: 'percent', value: 12.5 }, { type: 'amount', value: '3.33' }, undefined]) {
        assert.deepStrictEqual(legacy(invoiceTotals(items, rate, d)), before(items, rate, d));
        assert.deepStrictEqual(legacy(invoiceTotals(items, rate, d, {})), before(items, rate, d));
      }
    }
  }
});

test('every breakdown reconciles to the cent across awkward amounts', () => {
  const prices = [0.01, 0.07, 1.99, 33.33, 99.99];
  const cats = ['standard', 'zero', 'exempt'];
  const discounts = [undefined, { type: 'percent', value: 7 }, { type: 'percent', value: 33.3 }, { type: 'amount', value: 0.05 }];
  const cents = n => Math.round(n * 100);
  let checked = 0;
  for (const p of prices) {
    for (let qty = 1; qty <= 3; qty++) {
      const items = [
        { qty, price: p },
        { qty, price: round2(p * 3), vatCat: 'zero' },
        { qty: 1, price: p, vatCat: 'exempt' },
        { qty: qty + 1, price: p },
      ];
      for (const rate of [15, 14, 0]) {
        for (const inclusive of [false, true]) {
          for (const d of discounts) {
            const t = invoiceTotals(items, rate, d, { inclusive });
            const msg = JSON.stringify({ p, qty, rate, inclusive, d });
            assert.strictEqual(cents(t.net) + cents(t.vat), cents(t.total), msg);
            assert.strictEqual(cents(t.subtotal) - cents(t.discount), cents(inclusive ? t.total : t.net), msg);
            assert.strictEqual(cats.reduce((s, c) => s + cents(t.categories[c].discount), 0), cents(t.discount), msg);
            assert.strictEqual(cats.reduce((s, c) => s + cents(t.categories[c].net), 0), cents(t.net), msg);
            assert.strictEqual(cats.reduce((s, c) => s + cents(t.categories[c].vat), 0), cents(t.vat), msg);
            assert.strictEqual(cats.reduce((s, c) => s + cents(t.categories[c].total), 0), cents(t.total), msg);
            for (const c of cats) {
              const k = t.categories[c];
              assert.strictEqual(cents(k.net) + cents(k.vat), cents(k.total), msg);
              assert.strictEqual(cents(k.amount) / 100, k.amount, msg); // whole cents
              if (c !== 'standard') assert.strictEqual(k.vat, 0, msg);
            }
            // every value is whole cents
            for (const v of [t.subtotal, t.discount, t.net, t.vat, t.total]) assert.strictEqual(cents(v) / 100, v, msg);
            checked++;
          }
        }
      }
    }
  }
  assert.strictEqual(checked, 5 * 3 * 3 * 2 * 4);
});
