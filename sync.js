// sync.js
//
// Node 18+ has a built‑in `fetch`. No need for node‑fetch.
// Installs: chrome-aws-lambda, puppeteer-core

const chromium = require('chrome-aws-lambda');
const puppeteer = chromium.puppeteer || require('puppeteer-core');

const {
  WOOCOMMERCE_API_URL,
  WOOCOMMERCE_CONSUMER_KEY,
  WOOCOMMERCE_CONSUMER_SECRET,
  FABRIC_CATEGORY_ID,
  WARD_URL_META_KEY = 'warde_url'
} = process.env;

if (
  !WOOCOMMERCE_API_URL ||
  !WOOCOMMERCE_CONSUMER_KEY ||
  !WOOCOMMERCE_CONSUMER_SECRET ||
  !FABRIC_CATEGORY_ID
) {
  console.error(
    'Missing one of WOOCOMMERCE_API_URL, WOOCOMMERCE_CONSUMER_KEY, ' +
    'WOOCOMMERCE_CONSUMER_SECRET or FABRIC_CATEGORY_ID'
  );
  process.exit(1);
}

async function fetchAllFabrics() {
  const auth = Buffer.from(
    `${WOOCOMMERCE_CONSUMER_KEY}:${WOOCOMMERCE_CONSUMER_SECRET}`
  ).toString('base64');

  const url = `${WOOCOMMERCE_API_URL.replace(/\/$/, '')}` +
              `/wp-json/wc/v3/products?category=${FABRIC_CATEGORY_ID}&per_page=100`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Basic ${auth}` }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Fetch fabrics failed (${res.status}): ${txt}`);
  }
  return res.json();
}

async function updateStock(id, stock) {
  const endpoint = `${WOOCOMMERCE_API_URL.replace(/\/$/, '')}` +
                   `/wp-json/wc/v3/products/${id}`;
  const auth = Buffer.from(
    `${WOOCOMMERCE_CONSUMER_KEY}:${WOOCOMMERCE_CONSUMER_SECRET}`
  ).toString('base64');

  const res = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${auth}`
    },
    body: JSON.stringify({
      stock_quantity: stock,
      stock_status: stock > 0 ? 'instock' : 'outofstock'
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Update failed (${res.status}): ${txt}`);
  }
  return res.json();
}

async function scrapeStock(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2' });
  // find element with “Available Stock”
  const [label] = await page.$x("//*[contains(text(), 'Available Stock')]");
  if (!label) throw new Error('No “Available Stock” label found');
  const text = await page.evaluate(el => el.nextElementSibling?.textContent, label);
  if (!text) throw new Error('Stock text not found after label');
  const qty = parseInt(text.replace(/\D/g, ''), 10);
  if (isNaN(qty)) throw new Error(`Cannot parse quantity from “${text}”`);
  return qty;
}

(async () => {
  let browser;

  try {
    console.log('🔎 Fetching fabric products…');
    const products = await fetchAllFabrics();
    if (!products.length) {
      console.warn('No products found in category', FABRIC_CATEGORY_ID);
      process.exit(0);
    }

    browser = await chromium.puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: chromium.headless
    });
    const page = await browser.newPage();

    for (const prod of products) {
      const meta = prod.meta_data.find(m => m.key === WARD_URL_META_KEY);
      if (!meta?.value) {
        console.warn(`– [${prod.id}] Missing meta "${WARD_URL_META_KEY}", skipping`);
        continue;
      }

      try {
        console.log(`→ [${prod.id}] Scraping ${meta.value}`);
        const stock = await scrapeStock(page, meta.value);
        console.log(`   • Found stock: ${stock}`);
        await updateStock(prod.id, stock);
        console.log(`   ✓ Updated WooCommerce product ${prod.id}`);
      } catch (err) {
        console.error(`   ✗ [${prod.id}] ${err.message}`);
      }
    }
  } catch (err) {
    console.error('‼️ Fatal error:', err);
  } finally {
    if (browser) await browser.close();
  }
})();
