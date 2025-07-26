// sync.js
//
// Node 18+ has built‑in fetch. Installs: chrome-aws-lambda, puppeteer-core

const chromium = require('chrome-aws-lambda');
const puppeteer = chromium.puppeteer || require('puppeteer-core');

const {
  WOOCOMMERCE_API_URL,
  WOOCOMMERCE_CONSUMER_KEY,
  WOOCOMMERCE_CONSUMER_SECRET,
  WARD_URL_META_KEY = 'warde_url'
} = process.env;

if (!WOOCOMMERCE_API_URL ||
    !WOOCOMMERCE_CONSUMER_KEY ||
    !WOOCOMMERCE_CONSUMER_SECRET
) {
  console.error(
    'Error: Missing WOOCOMMERCE_API_URL, WOOCOMMERCE_CONSUMER_KEY or WOOCOMMERCE_CONSUMER_SECRET'
  );
  process.exit(1);
}

async function fetchAllProducts() {
  const auth = Buffer.from(
    `${WOOCOMMERCE_CONSUMER_KEY}:${WOOCOMMERCE_CONSUMER_SECRET}`
  ).toString('base64');
  const base = `${WOOCOMMERCE_API_URL.replace(/\/$/, '')}/wp-json/wc/v3/products`;
  let page = 1, perPage = 100, all = [];
  while (true) {
    const res = await fetch(`${base}?per_page=${perPage}&page=${page}`, {
      headers: { 'Authorization': `Basic ${auth}` }
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Fetch products failed (${res.status}): ${txt}`);
    }
    const batch = await res.json();
    if (!batch.length) break;
    all.push(...batch);
    page++;
  }
  return all;
}

async function updateStock(id, stock) {
  const endpoint = `${WOOCOMMERCE_API_URL.replace(/\/$/, '')}`
                 + `/wp-json/wc/v3/products/${id}`;
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
  const [label] = await page.$x("//*[contains(text(),'Available Stock')]");
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
    console.log('🔎 Fetching all products…');
    const all = await fetchAllProducts();
    const fabrics = all.filter(p =>
      p.meta_data.some(m => m.key === WARD_URL_META_KEY && m.value)
    );
    if (!fabrics.length) {
      console.warn(`No products with meta "${WARD_URL_META_KEY}" found.`);
      return;
    }
    browser = await chromium.puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: chromium.headless
    });
    const page = await browser.newPage();
    for (const prod of fabrics) {
      const meta = prod.meta_data.find(m => m.key === WARD_URL_META_KEY);
      try {
        console.log(`→ [${prod.id}] Scraping ${meta.value}`);
        const stock = await scrapeStock(page, meta.value);
        console.log(`   • Found stock: ${stock}`);
        await updateStock(prod.id, stock);
        console.log(`   ✓ Updated product ${prod.id}`);
      } catch (err) {
        console.error(`   ✗ [${prod.id}] ${err.message}`);
      }
    }
  } catch (err) {
    console.error('‼️ Fatal error:', err);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
