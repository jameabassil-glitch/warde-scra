// sync.js
//
// Uses axios + cheerio for HTML scraping—no headless browser needed.

const axios = require('axios');
const cheerio = require('cheerio');

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
  let page = 1;
  const perPage = 100;
  const all = [];

  while (true) {
    const res = await axios.get(base, {
      params: { per_page: perPage, page },
      headers: { Authorization: `Basic ${auth}` }
    });
    if (!res.data.length) break;
    all.push(...res.data);
    page++;
  }

  return all;
}

async function updateStock(id, stock) {
  const endpoint = `${WOOCOMMERCE_API_URL.replace(/\/$/, '')}` +
                   `/wp-json/wc/v3/products/${id}`;
  const auth = Buffer.from(
    `${WOOCOMMERCE_CONSUMER_KEY}:${WOOCOMMERCE_CONSUMER_SECRET}`
  ).toString('base64');

  await axios.put(endpoint,
    { stock_quantity: stock, stock_status: stock > 0 ? 'instock' : 'outofstock' },
    { headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`
      }
    }
  );
}

async function scrapeStock(url) {
  const res = await axios.get(url);
  const $ = cheerio.load(res.data);

  // 1) Find <span class="title">Available Stock</span>
  // 2) Grab its sibling <span class="value"> text
  const titleEl = $('li.flex span.title')
    .filter((i, el) => $(el).text().trim() === 'Available Stock');

  if (!titleEl.length) {
    throw new Error('Could not find <span class="title">Available Stock</span>');
  }

  const valueText = titleEl
    .next('span.value')
    .text()
    .trim(); // e.g. "109 Meters"

  const match = valueText.match(/(\d+)/);
  if (!match) {
    throw new Error(`No numeric stock in "${valueText}"`);
  }

  return parseInt(match[1], 10);
}

(async () => {
  try {
    console.log('🔎 Fetching all products…');
    const products = await fetchAllProducts();

    const fabrics = products.filter(p =>
      p.meta_data.some(m => m.key === WARD_URL_META_KEY && m.value)
    );

    if (!fabrics.length) {
      console.warn(`No products found with meta "${WARD_URL_META_KEY}".`);
      return;
    }

    for (const prod of fabrics) {
      const url = prod.meta_data.find(m => m.key === WARD_URL_META_KEY).value;
      try {
        console.log(`→ [${prod.id}] Scraping ${url}`);
        const stock = await scrapeStock(url);
        console.log(`   • Found stock: ${stock}`);
        await updateStock(prod.id, stock);
        console.log(`   ✓ Updated product ${prod.id}`);
      } catch (err) {
        console.error(`   ✗ [${prod.id}] ${err.message}`);
      }
    }
  } catch (err) {
    console.error('‼️ Fatal error:', err.message);
    process.exit(1);
  }
})();
