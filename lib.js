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

const FIRST_NUMBERS = { invoice: 'INV-0001', quote: 'QUO-0001', credit: 'CN-0001' };

// Next free number in `type`'s sequence ('invoice', 'quote' or 'credit'): one past the highest saved one,
// or past `current` when that's higher (e.g. an unsaved draft), and never a number already saved.
function nextFreeNumber(list, type, current = '') {
  const sameType = Object.keys(list).filter(num => (list[num].docType || 'invoice') === type);
  if (current) sameType.push(current);
  let num = nextNumberAfter(sameType, FIRST_NUMBERS[type] || FIRST_NUMBERS.invoice);
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

// Amount still owed after payments and `credited` (credit notes issued against it). Never below 0:
// an overpayment shows as a zero balance, not a credit.
function balanceDue(total, payments, credited = 0) {
  return Math.max(0, round2((total || 0) - paymentsTotal(payments) - (credited || 0)));
}

// Grand total of a document as saved (the same sum the sheet shows).
function savedTotal(doc) {
  const vatOn = !!doc.vatToggle;
  return invoiceTotals(doc.items || [], vatOn ? parseFloat(doc.vatRate) || 0 : 0,
    { type: doc.discountType, value: doc.discountValue }, { inclusive: !!(vatOn && doc.vatInclusive) }).total;
}

// Sum of the saved credit notes in `list` issued against invoice `invoiceNumber`. `exclude` is a number
// to leave out — the credit note being saved, whose old copy it is about to replace.
function creditsTotal(list, invoiceNumber, exclude) {
  if (!list || !invoiceNumber) return 0;
  return round2(Object.keys(list).reduce((sum, num) => {
    const doc = list[num];
    const isCredit = num !== exclude && doc && doc.docType === 'credit' && doc.creditFor === invoiceNumber;
    return isCredit ? sum + Math.max(0, savedTotal(doc)) : sum;
  }, 0));
}

// How much can still be credited on a saved invoice: its total less the credit notes already issued
// against it (apart from `exclude`). A credit note may not go over this.
function creditRemaining(list, invoiceNumber, exclude) {
  const original = list && list[invoiceNumber];
  if (!original) return 0;
  return Math.max(0, round2(savedTotal(original) - creditsTotal(list, invoiceNumber, exclude)));
}

// today is YYYY-MM-DD; ISO dates compare correctly as strings. A quote's dueDate is its "valid until".
// `total` (the invoice's grand total) lets payments that cover it count as Paid; leave it out and only the paid flag does.
// Quotes: Accepted / Declined (inv.quoteStatus) win over Expired. Invoices: Paid, else Overdue (even with
// part payments, so one status string), else 'Part paid', else ''.
// `credited` is the sum of credit notes issued against the invoice (needs `total` too). Rules:
// - credits alone cover the total → 'Credited', even if payments were received (they're owed back, not owing);
// - otherwise ticked paid, or payments + credits cover it with at least one payment → 'Paid';
// - a part credit on its own doesn't get a status: it only lowers the balance (and can still be Overdue).
// Credit notes have no status of their own; the ledger labels them "Credit for …".
function invoiceStatus(inv, today, total, credited = 0) {
  const late = inv.dueDate && inv.dueDate < today;
  if (inv.docType === 'credit') return '';
  if (inv.docType === 'quote') {
    if (inv.quoteStatus === 'accepted') return 'Accepted';
    if (inv.quoteStatus === 'declined') return 'Declined';
    return late ? 'Expired' : '';
  }
  const received = paymentsTotal(inv.payments);
  const known = total !== undefined;
  if (known && credited > 0 && round2(credited) >= round2(total)) return 'Credited';
  if (inv.paid || (received > 0 && known && round2(received + (credited || 0)) >= round2(total))) return 'Paid';
  if (late) return 'Overdue';
  return received > 0 ? 'Part paid' : '';
}

// Everything the ledger needs to know about saved document `num`: its kind, total, credits received,
// status and balance. `unpaid` = an invoice that still has a balance and isn't Paid or Credited.
function ledgerEntry(list, num, today) {
  const doc = list[num];
  const kind = doc.docType === 'credit' || doc.docType === 'quote' ? doc.docType : 'invoice';
  const total = savedTotal(doc);
  const credited = kind === 'invoice' ? creditsTotal(list, num) : 0;
  const status = invoiceStatus(doc, today, total, credited);
  const balance = kind === 'invoice' ? balanceDue(total, doc.payments, credited) : 0;
  const unpaid = kind === 'invoice' && status !== 'Paid' && status !== 'Credited' && balance > 0;
  return { kind, total, credited, status, balance, unpaid };
}

// Money still owed, per currency: { [currency]: { outstanding, overdue, count, overdueCount } }.
// Only unpaid invoices count (quotes and credit notes don't, though credits already lower balances),
// and only currencies that have some appear.
function ledgerTotals(list, today) {
  const out = {};
  Object.keys(list || {}).forEach(num => {
    const e = ledgerEntry(list, num, today);
    if (!e.unpaid) return;
    const cur = list[num].currency || 'ZAR';
    const t = out[cur] ||= { outstanding: 0, overdue: 0, count: 0, overdueCount: 0 };
    t.outstanding = round2(t.outstanding + e.balance);
    t.count++;
    if (e.status === 'Overdue') { t.overdue = round2(t.overdue + e.balance); t.overdueCount++; }
  });
  return out;
}

// Does saved document `num` belong in the ledger for this search text and status filter?
// Search is case-insensitive over the number, the client name and the line descriptions.
function ledgerMatches(list, num, today, query, filter) {
  const doc = list[num];
  const e = ledgerEntry(list, num, today);
  const byFilter = {
    all: true, unpaid: e.unpaid, overdue: e.kind === 'invoice' && e.status === 'Overdue',
    part: e.kind === 'invoice' && e.status === 'Part paid', paid: e.kind === 'invoice' && e.status === 'Paid',
    quote: e.kind === 'quote', credit: e.kind === 'credit',
  };
  if (!(byFilter[filter] ?? true)) return false;
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [num, doc.toName, ...(Array.isArray(doc.items) ? doc.items.map(it => it && it.desc) : [])];
  return hay.some(h => String(h || '').toLowerCase().includes(q));
}

// `months` calendar months after an ISO date. Every step counts from the ORIGINAL day, clamped to the
// month's length, so 31 Jan → 28 Feb → 31 Mar (not 28 Mar).
function addMonths(isoDate, months) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const index = y * 12 + (m - 1) + Number(months);
  const year = Math.floor(index / 12);
  const month = index % 12;
  const day = Math.min(d, new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// The next date a saved repeating invoice is due to be repeated: invoice date + one month per period, the
// first period after `lastRepeated` (the scheduled date last created). '' when it doesn't repeat.
function nextRepeatDate(doc) {
  if (!doc || doc.repeat !== 'monthly' || (doc.docType || 'invoice') !== 'invoice' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.invDate || '')) return '';
  let n = 1;
  let next = addMonths(doc.invDate, n);
  while (doc.lastRepeated && next <= doc.lastRepeated && n < 1200) next = addMonths(doc.invDate, ++n);
  return next;
}

// Repeating invoices whose next date is today or earlier, oldest first: [{ num, date }].
function dueRepeats(list, today) {
  return Object.keys(list || {})
    .map(num => ({ num, date: nextRepeatDate(list[num]) }))
    .filter(r => r.date && r.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.num.localeCompare(b.num));
}

// One CSV cell, RFC 4180: quoted when it holds a comma, quote, CR or LF, inner quotes doubled.
// Numbers are written as they are; text that a spreadsheet would run as a formula (= + - @, tab or CR first)
// gets a leading ' so it opens as plain text.
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// rows: array of arrays (header first). CRLF line endings, UTF-8 BOM so Excel reads accents and rand signs right.
function toCSV(rows) {
  return '﻿' + rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

// Zoho Books' invoice import column names, from its own sample file (books.zoho.com/common/import/sample_invoices.csv).
// 'Product Type' isn't in that sample; Zoho ignores a column you don't map.
const ZOHO_INVOICE_HEADERS = ['Invoice Date', 'Invoice Number', 'Invoice Status', 'Customer Name', 'Due Date',
  'Currency Code', 'Item Name', 'Item Desc', 'Product Type', 'Quantity', 'Item Price', 'Discount Type',
  'Entity Discount Percent', 'Entity Discount Amount', 'Is Discount Before Tax', 'Is Inclusive Tax',
  'Item Tax1', 'Item Tax1 Type', 'Item Tax1 %', 'Notes', 'Terms & Conditions'];

// A plain decimal for a number column: dot, no grouping, no exponent. '' when blank or not a number.
function csvNumber(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? +n.toFixed(6) : '';
}

// Zoho keeps only the name, description, quantity and rate of a line (it drops the unit), so the first line of
// the description is the item name (max 100 chars, the overflow moves to the description) and the rest of the
// description plus "(qty unit)" is the description.
function zohoItemText(item) {
  const lines = String(item.desc || '').split(/\r?\n/).map(l => l.trim());
  const first = lines.shift() || '';
  const name = first.slice(0, 100) || 'Item';
  const rest = [first.slice(100).trim(), ...lines].join('\n').trim();
  const unit = String(item.unit || '').trim();
  const suffix = unit ? `(${csvNumber(item.qty) === '' ? item.qty : csvNumber(item.qty)} ${unit})` : '';
  return { name, desc: [rest, suffix].filter(Boolean).join(rest ? ' ' : '') };
}

// Header + one row per line of each saved invoice in `numbers` (quotes and credit notes are skipped).
// Invoice-level columns repeat on every row. Status is always Draft: payments aren't part of this import.
// The discount is an entity-level one, before tax. Tax columns only when VAT is on: standard lines carry the
// rate, zero-rated lines 0, exempt lines no tax at all.
function zohoInvoiceRows(list, numbers, taxName = 'VAT') {
  const rows = [ZOHO_INVOICE_HEADERS];
  numbers.forEach(num => {
    const doc = list[num];
    if (!doc || (doc.docType || 'invoice') !== 'invoice') return;
    const vatOn = !!doc.vatToggle;
    const rate = csvNumber(doc.vatRate) || 0;
    const items = Array.isArray(doc.items) ? doc.items : [];
    const subtotal = invoiceTotals(items, 0).subtotal;
    const value = Math.max(0, parseFloat(doc.discountValue) || 0);
    const amount = doc.discountType === 'amount';
    const off = value > 0 ? (amount ? discountAmount(subtotal, { type: 'amount', value }) : Math.min(value, 100)) : '';
    items.forEach(item => {
      const { name, desc } = zohoItemText(item);
      const cat = vatCategory(item);
      const taxed = vatOn && cat !== 'exempt';
      rows.push([
        doc.invDate || '', doc.invNumber || num, 'Draft', doc.toName || '', doc.dueDate || '',
        doc.currency || 'ZAR', name, desc, 'services', csvNumber(item.qty), csvNumber(item.price),
        off === '' ? '' : 'entity_level',
        off !== '' && !amount ? off : '', off !== '' && amount ? off : '', off === '' ? '' : 'true',
        vatOn ? String(!!doc.vatInclusive) : '',
        taxed ? taxName : '', taxed ? 'ItemAmount' : '', taxed ? (cat === 'zero' ? 0 : rate) : '',
        doc.notes || '', doc.terms || '',
      ]);
    });
  });
  return rows;
}

// Bank details printed as "Pay by EFT". `details` holds bankName / bankHolder / bankAccount / bankBranch / bankType.
const EFT_ACCOUNT_TYPES = { cheque: 'Cheque / Current', savings: 'Savings', transmission: 'Transmission' };

// [label, value] rows for the EFT block: the bank fields that are filled, then the reference (the invoice number).
// [] when no bank field is filled, so a bare reference never prints on its own.
function eftRows(details, reference) {
  const d = details || {};
  const text = k => (typeof d[k] === 'string' ? d[k].trim() : '');
  const rows = [['Bank', text('bankName')], ['Account holder', text('bankHolder')], ['Account number', text('bankAccount')],
    ['Branch code', text('bankBranch')], ['Account type', EFT_ACCOUNT_TYPES[d.bankType] || '']].filter(r => r[1]);
  const ref = typeof reference === 'string' ? reference.trim() : '';
  if (rows.length && ref) rows.push(['Reference', ref]);
  return rows;
}

// Online payment link from a URL template with {amount}, {number} and {currency}; each value is URL-encoded.
// Returns the URL, or '' unless the result is a plain https URL: imported backups can hold anything, and a
// javascript: / data: / http: link must never reach an href. Whitespace, < and > (an unfilled "<name>") are rejected too.
function paymentLink(template, { amount, number, currency } = {}) {
  if (typeof template !== 'string') return '';
  const text = template.trim();
  if (!text || /[\s<>]/.test(text)) return '';
  const n = typeof amount === 'number' ? amount : parseFloat(amount);
  const values = {
    amount: Number.isFinite(n) ? n.toFixed(2) : '',
    number: String(number ?? '').trim(),
    currency: String(currency ?? '').trim(),
  };
  const filled = text.replace(/\{(amount|number|currency)\}/g, (_, k) => encodeURIComponent(values[k]));
  try {
    const url = new URL(filled);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

// --- Saving to a folder: one JSON file per document, inside one subfolder per client ---

const NO_CLIENT_FOLDER = 'No client';
var DELETED_FOLDER = '_deleted'; // holds one small file per deleted document; no client folder may use this name

// A name that is safe as a file or folder name on Windows, macOS and Linux, or '' when nothing usable is left.
// Strips the characters Windows forbids and control characters, trailing dots/spaces, leading dots, and
// reserved device names (CON, NUL, COM1 …); capped at 80 characters.
function cleanFileName(name) {
  let s = String(name ?? '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ')
    .trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
  return s.slice(0, 80).replace(/[. ]+$/, '');
}

function safeFolderName(name) {
  const s = cleanFileName(name) || NO_CLIENT_FOLDER;
  return s.toLowerCase() === DELETED_FOLDER ? `${s} (client)` : s;
}

// { 'Client/INV-0001.json': text } for every saved document: where each one goes and what the file holds.
// `deleted` ({ number: deletedAt }) adds one '_deleted/<number>.json' record per deleted document, so a deletion
// reaches the other computers that share the folder. Two files that would land on the same path (compared
// case-insensitively, as Windows and macOS do) get " (2)" etc.
function folderPlan(list, deleted) {
  const plan = {};
  const taken = new Set();
  const place = (dir, num, text) => {
    const base = cleanFileName(num) || 'document';
    let name = base;
    for (let n = 2; taken.has(`${dir}/${name}.json`.toLowerCase()); n++) name = `${base} (${n})`;
    const path = `${dir}/${name}.json`;
    taken.add(path.toLowerCase());
    plan[path] = text;
  };
  Object.keys(list || {}).sort().forEach(num => {
    const doc = list[num];
    if (doc && typeof doc === 'object') place(safeFolderName(doc.toName), num, JSON.stringify(doc, null, 2));
  });
  Object.keys(deleted || {}).sort().forEach(num => {
    const at = deleted[num];
    if (typeof at === 'number' && Number.isFinite(at) && at > 0) place(DELETED_FOLDER, num, JSON.stringify({ invNumber: num, deletedAt: at }, null, 2));
  });
  return plan;
}

// What to do to turn the files we last wrote (`prev`) into `next`: both are { path: text }.
// Only paths in `prev` are ever removed, so a file the user put there themselves is never touched.
function diffPlan(prev, next) {
  const write = Object.keys(next).filter(p => prev[p] !== next[p]);
  const remove = Object.keys(prev).filter(p => !(p in next));
  return { write, remove };
}

// [number, doc] from a document file's text, or null when it isn't a document we could have written.
// `stem` (the file name without .json) is the number when the file doesn't carry one.
function parseFolderDoc(text, stem) {
  const doc = safeParse(text, null);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  if (doc.items !== undefined && !Array.isArray(doc.items)) return null;
  const num = (typeof doc.invNumber === 'string' ? doc.invNumber.trim() : '') || String(stem || '').trim();
  if (!num || ['__proto__', 'constructor', 'prototype'].includes(num)) return null;
  return [num, doc];
}

// [number, deletedAt] from a deletion record's text, or null when it isn't one.
function parseTombstone(text) {
  const rec = safeParse(text, null);
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const num = typeof rec.invNumber === 'string' ? rec.invNumber.trim() : '';
  if (!num || ['__proto__', 'constructor', 'prototype'].includes(num)) return null;
  return typeof rec.deletedAt === 'number' && Number.isFinite(rec.deletedAt) && rec.deletedAt > 0 ? [num, rec.deletedAt] : null;
}

// --- Edit times ---
// Every saved document carries `updatedAt` (ms since 1970): when it last really changed. It is what lets two
// copies of a document be compared, so the newer one wins when a folder and this browser disagree.

const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];

// `next` is the list about to be saved, `prev` what is saved now. A document that is new or whose content changed
// gets `updatedAt: now` (always after its previous stamp, so two edits in one millisecond still order). One whose
// content is the same keeps its old stamp, so re-saving without changes changes nothing. `keep` leaves the stamps
// exactly as given: used when documents arrive from elsewhere (a backup, a folder) with times of their own.
function stampChanges(prev, next, now, keep) {
  const out = {};
  Object.keys(next || {}).forEach(num => {
    if (UNSAFE_KEYS.includes(num)) return;
    const doc = next[num];
    if (keep || !doc || typeof doc !== 'object' || Array.isArray(doc)) { out[num] = doc; return; }
    const old = prev && Object.prototype.hasOwnProperty.call(prev, num) && prev[num] && typeof prev[num] === 'object' ? prev[num] : null;
    const { updatedAt, ...rest } = doc;
    const { updatedAt: oldAt, ...oldRest } = old || {};
    const had = typeof oldAt === 'number' ? oldAt : undefined;
    if (!old || JSON.stringify(rest) !== JSON.stringify(oldRest)) out[num] = { ...rest, updatedAt: Math.max(now, (had ?? 0) + 1) };
    else out[num] = had !== undefined ? { ...rest, updatedAt: had } : doc;
  });
  return out;
}

function editTime(doc) { return doc && typeof doc.updatedAt === 'number' ? doc.updatedAt : 0; }

// Combines this browser's saved list with the documents found in a folder. A document in only one place is kept.
// When both have a number but different contents, the newer `updatedAt` wins. When neither is newer (the same
// stamp, or no stamps because they were saved before times were recorded) it is a conflict: `ties` ('folder' or
// 'local') says whose copy to keep. Returns { merged, imported (new from the folder), replaced (folder's copy won),
// conflicts (the ties) }.
function mergeLists(local, folder, ties) {
  const merged = { ...local };
  const imported = [];
  const replaced = [];
  const conflicts = [];
  Object.keys(folder || {}).forEach(num => {
    if (UNSAFE_KEYS.includes(num)) return;
    if (!Object.prototype.hasOwnProperty.call(local, num)) { merged[num] = folder[num]; imported.push(num); return; }
    if (JSON.stringify(local[num]) === JSON.stringify(folder[num])) return;
    const a = editTime(local[num]);
    const b = editTime(folder[num]);
    if (b > a) { merged[num] = folder[num]; replaced.push(num); return; }
    if (b < a) return;
    conflicts.push(num);
    if (ties === 'folder') { merged[num] = folder[num]; replaced.push(num); }
  });
  return { merged, imported, replaced, conflicts };
}

// --- Deleted documents ---
// A deletion is remembered as { number: deletedAt } so it can reach the other computers sharing a folder; without
// it the document would just be copied back from the computer that still has it. A document with a later `updatedAt`
// than the deletion (the number was reused, or it was edited after) beats the record. Records are dropped after
// 180 days: a computer that has been away longer than that may bring a deleted document back.
const DELETION_KEEP_MS = 180 * 86400000;

function pruneDeleted(deleted, now) {
  const out = {};
  Object.keys(deleted || {}).forEach(num => {
    const at = deleted[num];
    if (!UNSAFE_KEYS.includes(num) && typeof at === 'number' && Number.isFinite(at) && now - at <= DELETION_KEEP_MS) out[num] = at;
  });
  return out;
}

// mergeLists plus deletions: records from both sides are combined (latest per number); a document whose edit time
// is not after its deletion is dropped, and a record that a later edit beats is forgotten. Returns everything
// mergeLists does, plus `deleted` (the combined records) and `removed` (numbers dropped from the merged list).
function mergeSync(local, localDeleted, folder, folderDeleted, ties, now) {
  const m = mergeLists(local, folder, ties);
  const deleted = {};
  [localDeleted, folderDeleted].forEach(side => Object.keys(side || {}).forEach(num => {
    if (!UNSAFE_KEYS.includes(num) && typeof side[num] === 'number') deleted[num] = Math.max(deleted[num] || 0, side[num]);
  }));
  const removed = [];
  Object.keys(m.merged).forEach(num => {
    if (!Object.prototype.hasOwnProperty.call(deleted, num)) return;
    if (editTime(m.merged[num]) > deleted[num]) delete deleted[num];
    else { delete m.merged[num]; removed.push(num); }
  });
  const gone = new Set(removed);
  const keep = nums => nums.filter(n => !gone.has(n));
  return { merged: m.merged, imported: keep(m.imported), replaced: keep(m.replaced), conflicts: keep(m.conflicts),
    deleted: pruneDeleted(deleted, now), removed };
}

// --- SARS tax-invoice advisory ---
// Advice shown beside a document that charges VAT; it never blocks saving. A full tax invoice (VAT Act s20) needs
// the supplier's name, address and VAT number, the recipient's name and address, a description of each line, and
// (from R5,000) the recipient's address and, if they are a VAT vendor, their VAT number.
const FULL_TAX_INVOICE_FROM = 5000;

// A South African VAT number: 10 digits starting with 4, possibly written with spaces or dashes.
function hasVatNumber(text) {
  return /(?<!\d)4\d{9}(?!\d)/.test(String(text || '').replace(/(\d)[ -](?=\d)/g, '$1'));
}

// doc: the document as collected from the form; total: its grand total including VAT.
// Returns a list of plain-language things to fix; [] when nothing is missing or the document isn't a VAT one.
function taxInvoiceIssues(doc, total) {
  if (!doc || !doc.vatToggle || doc.docType === 'quote') return [];
  const text = k => (typeof doc[k] === 'string' ? doc[k].trim() : '');
  const issues = [];
  if (!text('fromName')) issues.push('Add your business name under From.');
  if (!hasVatNumber(doc.fromDetails)) issues.push('Add your 10-digit VAT number to your details under From. A tax invoice must show it.');
  if (!text('toName')) issues.push('Add the client’s name under Bill to.');
  if ((doc.currency || 'ZAR') === 'ZAR' && total >= FULL_TAX_INVOICE_FROM && !text('toDetails')) {
    issues.push('This is R5,000 or more: add the client’s address, and their VAT number if they are VAT-registered.');
  }
  const items = Array.isArray(doc.items) ? doc.items : [];
  if (items.some(it => it && !String(it.desc || '').trim() && (parseFloat(it.qty) || 0) * (parseFloat(it.price) || 0) !== 0)) {
    issues.push('Every line needs a description.');
  }
  return issues;
}

// --- Backups ---
const BACKUP_VERSION = 1;
const BACKUP_AFTER_DAYS = 30;

// A reminder to export a backup, or '' when none is due. `count` = saved documents, `lastBackup` and `today` are
// ISO dates ('' / null = never backed up), `covered` = the documents are already being copied to a folder.
// Never backed up: remind from the second document on. Backed up: remind once the last one is 30 days old.
function backupNudge({ count, lastBackup, today, covered }) {
  if (covered || !(count > 0)) return '';
  const docs = `${count} saved document${count === 1 ? '' : 's'}`;
  if (!lastBackup) return count >= 2 ? `You have ${docs} and no backup yet. Press Export backup so a cleared browser can’t take them.` : '';
  const days = Math.floor((Date.parse(today) - Date.parse(lastBackup)) / 86400000);
  return days >= BACKUP_AFTER_DAYS ? `Your last backup was ${days} days ago. Press Export backup to save your ${docs}.` : '';
}

// The object written to a backup file. `now` is a Date.
function makeBackup(invoices, logo, now) {
  return { app: 'invoice', version: BACKUP_VERSION, exported: now.toISOString(), invoices, logo };
}

// Reads backup file text: { invoices, logo } on success, { error } when it can't be used. Files from before
// backups carried a version count as version 1. Entries that aren't plain objects are dropped.
function parseBackup(text) {
  const data = safeParse(text, null);
  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.invoices || typeof data.invoices !== 'object' || Array.isArray(data.invoices)) {
    return { error: 'notBackup' };
  }
  if (data.version !== undefined && !(Number.isInteger(data.version) && data.version >= 1)) return { error: 'notBackup' };
  if (data.version > BACKUP_VERSION) return { error: 'newer' };
  const invoices = {};
  Object.keys(data.invoices).forEach(num => {
    const doc = data.invoices[num];
    if (['__proto__', 'constructor', 'prototype'].includes(num)) return;
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) invoices[num] = doc;
  });
  return { invoices, logo: typeof data.logo === 'string' ? data.logo : null };
}

if (typeof module === 'object') module.exports = { hasVatNumber, taxInvoiceIssues, FULL_TAX_INVOICE_FROM, BACKUP_VERSION, makeBackup, backupNudge, parseBackup, cleanFileName, safeFolderName, NO_CLIENT_FOLDER, folderPlan, diffPlan, parseFolderDoc, parseTombstone, mergeLists, mergeSync, pruneDeleted, DELETED_FOLDER, DELETION_KEEP_MS, editTime, stampChanges, localISODate, addDays, safeParse, round2, vatCategory, invoiceTotals, nextInvoiceNumber, nextNumberAfter, nextFreeNumber, paymentsTotal, balanceDue, savedTotal, creditsTotal, creditRemaining, invoiceStatus, ledgerEntry, ledgerTotals, ledgerMatches, addMonths, nextRepeatDate, dueRepeats, csvEscape, toCSV, csvNumber, zohoItemText, zohoInvoiceRows, ZOHO_INVOICE_HEADERS, eftRows, EFT_ACCOUNT_TYPES, paymentLink };
