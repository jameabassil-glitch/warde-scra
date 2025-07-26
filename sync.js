// sync.js
//
// Uses axios + cheerio for HTML scraping—no browser needed.

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
  let page = 1, perPage = 100, all = [];

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

  // find the element containing "Available Stock" and grab its next sibling's text
  let qtyText;
  $("*").each((_, el) => {
    if ($(el).text().trim().includes("Available Stock")) {
      qtyText = $(el).next().text().trim();
      return false; // break
    }
  });

  if (!qtyText) throw new Error('Could not find “Available Stock” in HTML');
  const n = parseInt(qtyText.replace(/\D/g, ''), 10);
  if (isNaN(n)) throw new Error(`Parsed non-number "${qtyText}"`);
  return n;
}

(async () => {
  try {
    console.log('🔎 Fetching all products…');
    const products = await fetchAllProducts();

    // only those with your custom-field
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
