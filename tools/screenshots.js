// Regenerates the manifest screenshots in screenshots/ from made-up sample data.
// Not part of the app or its tests. Needs Playwright with Chromium, which is not a dependency of this project:
//   npm install --no-save playwright && npx playwright install chromium && node tools/screenshots.js
// The app's files are served to the page from inside this process, so no web server is started.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const ORIGIN = 'http://localhost:8765';

const biz = { fromName: 'Studio One', fromDetails: '12 Loop Street\nCape Town, 8001\nhello@studioone.example\nVAT No. 4123456789', bankName: 'FNB', bankHolder: 'Studio One', bankAccount: '62000000000', bankBranch: '250655', bankType: 'cheque', payLink: 'https://pay.example.com/{number}?amount={amount}', vatToggle: true, vatRate: '15', currency: 'ZAR', discountType: 'percent', discountValue: '', vatInclusive: false, quoteStatus: '', creditReason: '', repeat: '', terms: '14' };
const doc = (num, o) => ({ ...biz, invNumber: num, docType: 'invoice', paid: false, notes: 'Thank you for your business.', payments: [], creditFor: '', lastRepeated: '', ...o });
const line = (desc, qty, unit, price) => ({ desc, qty, unit, price, vatCat: 'standard' });
const list = {
  'INV-0012': doc('INV-0012', { toName: 'Acme Printing (Pty) Ltd', toDetails: '48 Dock Road\nV&A Waterfront, Cape Town\nVAT No. 4987654321', toEmail: 'accounts@acme.example', invDate: '2026-11-10', dueDate: '2026-11-24',
    items: [line('Brand identity: logo and colour palette', 1, '', 8500), line('Website design, 5 pages', 5, 'pages', 1800), line('Social media templates', 12, 'items', 250), line('Copywriting', 6, 'hrs', 450)] }),
  'INV-0011': doc('INV-0011', { toName: 'Karoo Coffee Roasters', toDetails: '7 Church Street, Prince Albert', invDate: '2026-10-28', dueDate: '2026-11-11', paid: true, items: [line('Packaging design', 1, '', 6200)], payments: [{ date: '2026-11-09', amount: '7130', note: 'EFT' }] }),
  'INV-0010': doc('INV-0010', { toName: 'Bay Physio Group', toDetails: '3 Beach Road, Gqeberha', invDate: '2026-10-14', dueDate: '2026-10-28', items: [line('Website maintenance', 4, 'hrs', 600), line('Hosting, 12 months', 1, '', 2400)] }),
  'INV-0009': doc('INV-0009', { toName: 'Protea Wines', toDetails: '1 Vineyard Lane, Stellenbosch', invDate: '2026-10-02', dueDate: '2026-11-01', items: [line('Label illustrations', 3, 'items', 2200)], payments: [{ date: '2026-10-20', amount: '3000', note: 'Deposit' }] }),
  'QUO-0003': doc('QUO-0003', { docType: 'quote', toName: 'Sunbird Travel', toDetails: '22 Kloof Street, Cape Town', invDate: '2026-11-12', dueDate: '2026-12-12', items: [line('Booking site redesign', 1, '', 24000)] }),
};
const logoSvg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 72'><rect width='160' height='72' rx='10' fill='#1c2433'/><text x='80' y='44' font-family='Arial,sans-serif' font-weight='700' font-size='21' fill='#fff' text-anchor='middle'>Studio One</text></svg>";
const seed = { 'invoice-logo': 'data:image/svg+xml;base64,' + Buffer.from(logoSvg).toString('base64'), 'invoice-onboarded': '1', 'invoice-list': JSON.stringify(list), 'invoice-open': 'INV-0012', 'invoice-draft': JSON.stringify(list['INV-0012']) };

async function shot(browser, { name, viewport, dark, mobile, openLedger }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: !!mobile, hasTouch: !!mobile, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript(s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, { ...seed, theme: dark ? 'dark' : 'light' });
  await ctx.route(`${ORIGIN}/**`, route => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('.ledger-row', { state: 'attached' });
  await page.waitForFunction(() => !document.querySelector('.app').inert);
  await page.evaluate(() => document.fonts.ready);
  if (openLedger) await page.evaluate(() => { document.getElementById('ledger').open = true; });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(name, `${viewport.width}x${viewport.height}`);
  await ctx.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  await shot(browser, { name: 'wide-light', viewport: { width: 1280, height: 720 } });
  await shot(browser, { name: 'wide-dark', viewport: { width: 1280, height: 720 }, dark: true });
  await shot(browser, { name: 'narrow-invoice', viewport: { width: 390, height: 844 }, mobile: true });
  await shot(browser, { name: 'narrow-ledger', viewport: { width: 390, height: 844 }, mobile: true, openLedger: true });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
