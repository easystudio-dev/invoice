// Pure helpers — loaded as a plain script in the browser, require()'d by lib.test.js.

// YYYY-MM-DD in local time (toISOString() is UTC and gives yesterday's date just after midnight in SA).
function localISODate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00');
  d.setDate(d.getDate() + Number(days));
  return localISODate(d);
}

function safeParse(raw, fallback) {
  try { return JSON.parse(raw) ?? fallback; } catch { return fallback; }
}

// Half-away-from-zero to cents. ponytail: +1e-6 cent nudge fixes float cases like 1.005*100 = 100.4999…;
// only wrong for values within a millionth of a cent below .5, which qty × price never produces.
function round2(n) {
  return Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-6) / 100;
}

// Discount comes off the subtotal before VAT. It can't be negative or exceed the subtotal
// (a negative-price line can make the subtotal itself <= 0, which leaves nothing to discount).
function discountAmount(subtotal, discount) {
  const value = Math.max(0, parseFloat(discount && discount.value) || 0);
  const raw = discount && discount.type === 'amount' ? value : subtotal * value / 100;
  return Math.max(0, Math.min(round2(raw), subtotal));
}

const VAT_CATEGORIES = ['standard', 'zero', 'exempt'];

// Lines saved before VAT categories existed (or with an unknown value) are standard-rated.
function vatCategory(item) {
  return VAT_CATEGORIES.includes(item && item.vatCat) ? item.vatCat : 'standard';
}

// Splits `total` across `amounts` pro rata, each share rounded to cents. The rounding remainder goes on
// the largest amount so the shares always add up to `total` exactly.
function apportion(total, amounts, sum) {
  if (!total || !sum) return amounts.map(() => 0);
  const shares = amounts.map(a => round2(total * a / sum));
  const largest = amounts.indexOf(Math.max(...amounts));
  shares[largest] = round2(shares[largest] + total - round2(shares.reduce((a, b) => a + b, 0)));
  return shares;
}

// Each line is rounded before summing so the printed line totals add up exactly to the subtotal.
// `discount` is optional: { type: 'percent' | 'amount', value }. VAT is charged on `net`, the discounted subtotal.
// Items may carry `vatCat` ('standard' | 'zero' | 'exempt'); only standard lines pay `vatRate`. The discount is
// apportioned across the categories and VAT worked out per category on its discounted amount.
// `options.inclusive`: prices already include VAT, so `subtotal` and the lines are VAT-inclusive and the
// discounted subtotal is the total. Per category VAT = round2(gross × rate / (100 + rate)) and excl = gross − VAT,
// so excl + VAT = gross to the cent in every category and on the invoice.
// `categories[cat]` = { amount (as entered, before discount), discount, net (excl. VAT), vat, total }.
function invoiceTotals(items, vatRate, discount, options = {}) {
  const rate = vatRate || 0;
  const inclusive = !!options.inclusive;
  const lineTotals = items.map(it => round2((parseFloat(it.qty) || 0) * (parseFloat(it.price) || 0)));
  const subtotal = round2(lineTotals.reduce((a, b) => a + b, 0));
  const discountOff = discountAmount(subtotal, discount);
  const amounts = VAT_CATEGORIES.map(cat =>
    round2(lineTotals.reduce((sum, t, i) => (vatCategory(items[i]) === cat ? sum + t : sum), 0)));
  const shares = apportion(discountOff, amounts, subtotal);
  const categories = {};
  VAT_CATEGORIES.forEach((cat, i) => {
    const after = round2(amounts[i] - shares[i]);
    const r = cat === 'standard' ? rate : 0;
    const vat = round2(inclusive ? after * r / (100 + r) : after * r / 100);
    const net = inclusive ? round2(after - vat) : after;
    categories[cat] = { amount: amounts[i], discount: shares[i], net, vat, total: round2(net + vat) };
  });
  const vat = round2(VAT_CATEGORIES.reduce((sum, cat) => sum + categories[cat].vat, 0));
  const discounted = round2(subtotal - discountOff);
  const net = inclusive ? round2(discounted - vat) : discounted;
  return { lineTotals, subtotal, discount: discountOff, net, vat, total: inclusive ? discounted : round2(net + vat), categories };
}

// INV-0009 → INV-0010: bumps the last run of digits, keeping its zero padding.
function nextInvoiceNumber(num) {
  if (/\d/.test(num)) return num.replace(/\d+(?!.*\d)/, m => String(Number(m) + 1).padStart(m.length, '0'));
  return num ? num + '-2' : 'INV-0001';
}

// Number after the highest of `numbers`, or `fallback` when there are none.
// ponytail: plain string sort, so it assumes zero-padded numbers (INV-0009 < INV-0010).
function nextNumberAfter(numbers, fallback) {
  return numbers.length ? nextInvoiceNumber([...numbers].sort().pop()) : fallback;
}

// Next free number in `type`'s sequence ('invoice' or 'quote'): one past the highest saved one,
// or past `current` when that's higher (e.g. an unsaved draft), and never a number already saved.
function nextFreeNumber(list, type, current = '') {
  const sameType = Object.keys(list).filter(num => (list[num].docType || 'invoice') === type);
  if (current) sameType.push(current);
  let num = nextNumberAfter(sameType, type === 'quote' ? 'QUO-0001' : 'INV-0001');
  while (list[num]) num = nextInvoiceNumber(num);
  return num;
}

// Sum of recorded payments in cents-exact form. Blank, invalid and non-positive amounts are ignored.
function paymentsTotal(payments) {
  if (!Array.isArray(payments)) return 0;
  return round2(payments.reduce((sum, p) => {
    const amount = parseFloat(p && p.amount);
    return amount > 0 ? sum + amount : sum;
  }, 0));
}

// Amount still owed. Never below 0: an overpayment shows as a zero balance, not a credit.
function balanceDue(total, payments) {
  return Math.max(0, round2((total || 0) - paymentsTotal(payments)));
}

// today is YYYY-MM-DD; ISO dates compare correctly as strings. A quote's dueDate is its "valid until".
// `total` (the invoice's grand total) lets payments that cover it count as Paid; leave it out and only the paid flag does.
// Quotes: Accepted / Declined (inv.quoteStatus) win over Expired. Invoices: Paid, else Overdue (even with
// part payments, so one status string), else 'Part paid', else ''.
function invoiceStatus(inv, today, total) {
  const late = inv.dueDate && inv.dueDate < today;
  if (inv.docType === 'quote') {
    if (inv.quoteStatus === 'accepted') return 'Accepted';
    if (inv.quoteStatus === 'declined') return 'Declined';
    return late ? 'Expired' : '';
  }
  const received = paymentsTotal(inv.payments);
  if (inv.paid || (received > 0 && total !== undefined && received >= round2(total))) return 'Paid';
  if (late) return 'Overdue';
  return received > 0 ? 'Part paid' : '';
}

if (typeof module === 'object') module.exports = { localISODate, addDays, safeParse, round2, vatCategory, invoiceTotals, nextInvoiceNumber, nextNumberAfter, nextFreeNumber, paymentsTotal, balanceDue, invoiceStatus };
