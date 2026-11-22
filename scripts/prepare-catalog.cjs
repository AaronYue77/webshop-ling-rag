const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const input = process.argv[2] || path.join(root, "data", "webshop-779.json");
const bytes = fs.readFileSync(input);
const raw = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
if (!Array.isArray(raw) || raw.length !== 779) throw Error("Expected the 779-product WebShop export");

const text = value => String(value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const price = value => {
  const match = /^\$\s*([\d,]+)(?:\.(\d{1,2}))?$/.exec(text(value));
  return match ? Number(match[1].replace(/,/g, "")) * 100 + Number((match[2] || "").padEnd(2, "0")) : null;
};
const image = value => {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && /^(?:m\.media-amazon\.com|images[^.]*\.ssl-images-amazon\.com|images\.amazon\.com)$/.test(url.hostname) &&
        !/transparent-pixel|sprite|placeholder/i.test(url.pathname)) return url.href;
  } catch {}
  return null;
};
function options(rawOptions) {
  return Object.fromEntries(Object.entries(rawOptions || {}).filter(([,values]) => Array.isArray(values)).map(([key, values]) => [
    key,
    values.filter(value => text(value?.value)).map(value => ({
      value: text(value.value), price: price(value.price_string),
      selected: value.is_selected === true,
      asin: /\/dp\/([A-Z0-9]{10})/.exec(value.url || "")?.[1] || null,
      image: image(value.image)
    }))
  ]));
}
function labeled(s, labels) {
  const out = [];
  const stop = "(?:Upper Material|Sole Material|Outsole Material|Lining Material|Material|Fabric Type|Season|Closing Method|Closure Type|Heel High|Package Includes|Color|Pattern|Size|Dimensions|Weight)";
  for (const label of labels) {
    const pattern = new RegExp("(?:^|[\\s|;])(" + label + ")\\s*:\\s*(.{2,100}?)(?=\\s+" + stop + "\\s*:|[;|\\n]|$)", "i");
    const match = pattern.exec(s);
    if (match && match[2].length < 96) out.push([match[1], match[2].trim()]);
  }
  return out;
}
function normalize(p) {
  const info = p.product_information || {};
  const name = text(p.name);
  const trail = text(p.product_category);
  const audienceText = [name, info.Department].join(" ");
  const isMen = /\b(?:men'?s|men|male)\b/i.test(audienceText);
  const isWomen = /\b(?:women'?s|women|ladies|lady|female)\b/i.test(audienceText);
  const isShoe = (/(?:^|›)\s*Shoes\s*(?:›|$)/i.test(trail) ||
    p.category === "fashion" && !/›\s*(?:Clothing|Socks & Hosiery|Accessories)\s*(?:›|$)/i.test(trail) &&
      /\b(?:footwear|sneakers?|sandals?|booties|loafers?|ballet flats?|slippers?|shoes?)\b/i.test(name)) &&
    !/\b(?:shoe rack|shoe polish|shoe laces|shoe organizer|shoe storage|shoe charms|shoelaces|socks only)\b/i.test(name);
  const audience = isMen && !isWomen ? "men" : isWomen && !isMen ? "women" :
    /\b(?:girls|boys|kids|children|toddlers)\b/i.test(audienceText) ? "kids" :
      /› Women ›/i.test(trail) ? "women" : /› Men ›/i.test(trail) ? "men" : null;
  const description = text(p.full_description);
  const bullets = (Array.isArray(p.small_description) ? p.small_description : [p.small_description]).map(text).filter(Boolean);
  const variants = options(p.customization_options);
  const materials = new Map();
  const specs = {};
  for (const [key, value] of Object.entries(info)) {
    if (typeof value !== "string" || !text(value)) continue;
    if (/material|fabric type|composition/i.test(key)) materials.set(key.toLowerCase(), [key, text(value)]);
    if (/weight|dimensions|capacity|model number|model name|wattage|voltage|package|country of origin|form factor|ingredients|item form|compatible devices|connection type|connector type|hardware interface|size|color/i.test(key)) specs[key] = text(value).slice(0, 170);
  }
  for (const snippet of [description, ...bullets]) {
    for (const [key, value] of labeled(snippet, ["Upper Material","Sole Material","Outsole Material","Lining Material","Material","Fabric Type"])) {
      if (!materials.has(key.toLowerCase())) materials.set(key.toLowerCase(), [key, value]);
    }
  }
  const usChart = isShoe ? [...description.matchAll(/\bUS\s*:\s*(\d{1,2}(?:\.\d+)?)(?=\s|$)/gi)].map(m => m[1]) : [];
  const ukChart = isShoe ? [...description.matchAll(/\bUK\s*:\s*(\d{1,2}(?:\.\d+)?)(?=\s|$)/gi)].map(m => m[1]) : [];
  const availability = text(p.availability_status);
  const inventory = /currently unavailable|out of stock/i.test(availability) ? "out_of_stock" :
    /\bin stock\b/i.test(availability) ? "in_stock" : null;
  const compat = [...Object.entries(specs).filter(([key]) => /compatible|connector|interface/i.test(key)).map(([k,v]) => k + ": " + v),
    ...[name, description, ...bullets].flatMap(value => value.split(/(?<=[.!?])\s+|[;。]/))
      .filter(line => /\b(?:compatib|supports?|works with|designed for|fits)\w*/i.test(line)).slice(0, 12)].map(line => line.slice(0, 500));
  return {
    id: text(p.asin), name, category: p.category, trail, query: text(p.query),
    brand: text(p.brand).replace(/^Brand:\s*|^Visit the | Store$/gi, ""),
    price: price(p.pricing), listPrice: price(p.list_price), images: [...new Set((p.images || []).map(image).filter(Boolean))].slice(0, 8),
    variants, material: [...materials.values()], specs, audience, shoe: isShoe,
    sizeChart: {US: [...new Set(usChart)], UK: [...new Set(ukChart)]},
    inventory, quantity: Number.isInteger(p.availability_quantity) ? p.availability_quantity : null,
    compatibility: [...new Set(compat)], description: description.slice(0, 1500), bullets: bullets.slice(0, 6).map(x => x.slice(0, 330))
  };
}
const products = raw.map(normalize);
if (new Set(products.map(p => p.id)).size !== products.length || products.some(p => !/^[A-Z0-9]{10}$/.test(p.id))) throw Error("Expected unique ASINs");
const byCategory = Object.fromEntries([...new Set(products.map(p => p.category))].sort().map(category => [
  category, products.filter(p => p.category === category).length
]));
const meta = {
  count: products.length, byCategory, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  snapshotDate: null, currency: "USD", historySeries: false,
  womenShoes: products.filter(p => p.shoe && p.audience === "women").length,
  imageCount: products.filter(p => p.images.length).length,
  priceCount: products.filter(p => p.price !== null).length,
  variantSizePriceCount: products.filter(p => p.variants.Size?.some(v => v.price !== null)).length,
  inventoryQuantityCount: products.filter(p => p.quantity !== null).length
};
const catalog = {meta, products};
fs.writeFileSync(path.join(root, "web", "catalog.js"), "globalThis.ShopCatalog = " + JSON.stringify(catalog) + ";\n");
fs.writeFileSync(path.join(root, "data", "catalog-audit.json"), JSON.stringify(meta, null, 2) + "\n");
console.log(JSON.stringify(meta, null, 2));
