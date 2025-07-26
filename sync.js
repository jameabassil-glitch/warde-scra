#!/usr/bin/env node
/**
 * sync.js
 *
 * - Fetches all WooCommerce products with a `warde_url` custom field.
 * - Uses Puppeteer (bundled Chromium) to scrape “Available Stock” from each URL.
 * - Updates stock via WooCommerce REST API.
 */

const puppeteer = require('puppeteer');
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

// 2) Load products that have warde_url meta
async function loadProductsFromWoo() {
  const url = `${WOOCOMMERCE_API_URL.replace(/\/$/, '')}/wp-json/wc/v3/products?per_page=100&meta_key=warde_url`;
  const auth = Buffer.from(`${WOOCOMMERCE_CONSUMER_KEY}:${WOOCOMMERCE_CONSUMER_SECRET}`).toString('base64');
  const resp = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!resp.ok) throw new Error(`Fetch products failed: ${resp.status}`);
  const products = await resp.json();
  return products
    .map(p => {
      const meta = p.meta_data.find(m => m.key === 'warde_url');
      return meta && meta.value ? { id: p.id, wardeUrl: meta.value.trim() } : null;
    })
    .filter(Boolean);
}

// 3) Scrape stock number from Warde page
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
      const m = el.innerText.match(/Available\s*Stock\s*:? *(\d+)/i);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  });
}

// 4) Update WooCommerce stock via REST
async function updateStock(id, qty) {
  const url = `${WOOCOMMERCE_API_URL.replace(/\/$/, '')}/wp-json/wc/v3/products/${id}`;
  const auth = Buffer.from(`${WOOCOMMERCE_CONSUMER_KEY}:${WOOCOMMERCE_CONSUMER_SECRET}`).toString('base64');
  const body = { manage_stock: true };
  if (typeof qty === 'number') {
    body.stock_quantity = qty;
    body.stock_status   = qty > 0 ? 'instock' : 'outofstock';
  }
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Woo update failed for ${id}: ${res.status}`);
}

(async () => {
  const list    = await loadProductsFromWoo();
  console.log(`🔍 Found ${list.length} products with warde_url`);
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page    = await browser.newPage();

  for (const { id, wardeUrl } of list) {
    console.log(`→ [${id}] Visiting ${wardeUrl}`);
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
