#!/usr/bin/env node
/**
 * sync.js
 *  - Fetches all WooCommerce products that have a `warde_url` custom field.
 *  - Scrapes “Available Stock” from each Warde URL.
 *  - Updates the stock in WooCommerce.
 */

const chrome = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');
const fetch = require('node-fetch');

const {
  WOOCOMMERCE_API_URL,
  WOOCOMMERCE_CONSUMER_KEY,
  WOOCOMMERCE_CONSUMER_SECRET
} = process.env;

// 1) Validate environment
if (!WOOCOMMERCE_API_URL || !WOOCOMMERCE_CONSUMER_KEY || !WOOCOMMERCE_CONSUMER_SECRET) {
  console.error('❌ Missing one of: WOOCOMMERCE_API_URL, WOOCOMMERCE_CONSUMER_KEY, WOOCOMMERCE_CONSUMER_SECRET');
  process.exit(1);
}

// 2) Load products with warde_url meta
async function loadProductsFromWoo() {
  const url = `${WOOCOMMERCE_API_URL.replace(/\/$/, '')}/wp-json/wc/v3/products` +
              `?per_page=100&meta_key=warde_url`;
  const auth = Buffer.from(`${WOOCOMMERCE_CONSUMER_KEY}:${WOOCOMMERCE_CONSUMER_SECRET}`)
                     .toString('base64');
  const resp = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!resp.ok) throw new Error(`Failed to fetch products: ${resp.status}`);
  const list = await resp.json();
  return list
    .map(p => {
      const m = p.meta_data.find(m => m.key === 'warde_url');
      return m && m.value ? { id: p.id, wardeUrl: m.value.trim() } : null;
    })
    .filter(Boolean);
}

// 3) Launch headless Chrome
async function launchBrowser() {
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || await chrome.executablePath;
  return puppeteer.launch({
    args: [...chrome.args, '--no-sandbox'],
    defaultViewport: chrome.defaultViewport,
    executablePath: execPath,
    headless: true,
  });
}

// 4) Scrape stock number
async function extractStock(page) {
  try {
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('*'))
                .some(el => /Available\s*Stock/i.test(el.innerText)),
      { timeout: 15000 }
    );
  } catch {
    return null;
  }
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const t = el.innerText;
      const m = t.match(/Available\s*Stock\s*:? *(\d+)/i);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  });
}

// 5) Update WooCommerce stock
async function updateStock(id, qty) {
  const url = `${WOOCOMMERCE_API_URL.replace(/\/$/, '')}/wp-json/wc/v3/products/${id}`;
  const auth = Buffer.from(`${WOOCOMMERCE_CONSUMER_KEY}:${WOOCOMMERCE_CONSUMER_SECRET}`)
                     .toString('base64');
  const payload = { manage_stock: true };
  if (typeof qty === 'number') {
    payload.stock_quantity = qty;
    payload.stock_status   = qty > 0 ? 'instock' : 'outofstock';
  }
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Woo update error for ${id}: ${res.status}`);
}

(async () => {
  const list = await loadProductsFromWoo();
  console.log(`🔍 Found ${list.length} products with warde_url meta`);
  const browser = await launchBrowser();
  const page    = await browser.newPage();

  for (const { id, wardeUrl } of list) {
    console.log(`→ [${id}] Checking ${wardeUrl}`);
    try {
      await page.goto(wardeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const stock = await extractStock(page);
      console.log(`   • Stock: ${stock}`);
      await updateStock(id, stock);
      console.log(`   ✓ Updated WooCommerce for ${id}`);
    } catch (err) {
      console.error(`   ✗ Error on ${id}: ${err.message}`);
    }
  }

  await browser.close();
})();
