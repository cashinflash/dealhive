// DealHive nightly deal-pipeline. v0.2 — debug payload in /pullDealsNow.
//
// Runs every night, pulls fresh wholesale + listing data from:
//   1. Apify InvestorLift scraper (off-market wholesale assignments)
//   2. RentCast Listings API     (public for-sale listings, 6 cash-flow markets)
//
// Filters to residential 1-4 unit only, classifies each candidate against the
// buy-and-hold and fix-and-flip pro formas, dedupes by address, and writes the
// surviving deals to /deals in Firebase Realtime DB. The React app reads from
// there. If a source breaks (Apify scraper goes stale, RentCast quota maxed),
// it logs and continues — never wipes the existing /deals on a partial failure.
//
// Secrets are loaded via Firebase Secret Manager — set them once with:
//   firebase functions:secrets:set APIFY_API_KEY
//   firebase functions:secrets:set RENTCAST_API_KEY
//   firebase functions:secrets:set MANUAL_TRIGGER_SECRET   (for /pullDealsNow)
//
// Manual trigger for testing the pipeline without waiting for the cron:
//   curl "https://<region>-darallc.cloudfunctions.net/pullDealsNow?secret=XXXX"

const {onSchedule}   = require("firebase-functions/v2/scheduler");
const {onRequest}    = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {logger}       = require("firebase-functions/v2");
const admin          = require("firebase-admin");

admin.initializeApp();

const APIFY_API_KEY         = defineSecret("APIFY_API_KEY");
const RENTCAST_API_KEY      = defineSecret("RENTCAST_API_KEY");
const MANUAL_TRIGGER_SECRET = defineSecret("MANUAL_TRIGGER_SECRET");

// -- Config --------------------------------------------------------------------
// One anchor market per state we source from — used only by marketIdForState()
// to tag deals; the client builds its market filter dynamically from the data,
// so adding states here never requires a client change.
const MARKETS = [
  {id:"cle", city:"Cleveland",     state:"OH"},
  {id:"det", city:"Detroit",       state:"MI"},
  {id:"mem", city:"Memphis",       state:"TN"},
  {id:"bhm", city:"Birmingham",    state:"AL"},
  {id:"ind", city:"Indianapolis",  state:"IN"},
  {id:"kcm", city:"Kansas City",   state:"MO"},
  {id:"pit", city:"Pittsburgh",    state:"PA"},
  {id:"mil", city:"Milwaukee",     state:"WI"},
  {id:"bal", city:"Baltimore",     state:"MD"},
  {id:"jax", city:"Jacksonville",  state:"FL"},
  {id:"okc", city:"Oklahoma City", state:"OK"},
  {id:"lou", city:"Louisville",    state:"KY"},
  {id:"lit", city:"Little Rock",   state:"AR"},
  {id:"aus", city:"Austin",        state:"TX"},
  {id:"stl", city:"St. Louis",     state:"MO"},
  {id:"grn", city:"Greensboro",    state:"NC"},
  {id:"aug", city:"Augusta",       state:"GA"},
];

// Residential 1-4 unit only — these strings must match what normalizeType()
// emits below and what isResidential() in the React app accepts.
const RESIDENTIAL_TYPES = new Set([
  "Single Family", "Multi-Family", "Townhouse", "Condo",
]);

// Pull caps — env-tunable for live tuning without redeploy:
//   InvestorLift (Apify):   50 raw / day (nationwide, own cap)
//   DealHive 2 (FSBO.com):  browser actor — volume bounded by the metro list
//                           below plus this hard cap
const INVESTORLIFT_MAX  = parseInt(process.env.INVESTORLIFT_MAX  || "50",  10);
const FSBO_MAX          = parseInt(process.env.FSBO_MAX          || "150", 10);
// FSBO.com (real browser) and Zillow (44 zips) both outgrow run-sync's
// 300s ceiling, so they run start -> poll -> collect: the run gets a
// server-side kill switch (timeout= on the run start) and we poll up to
// LONG_RUN_WAIT_MS before the pipeline moves on with the partial harvest.
const LONG_RUN_TIMEOUT_S = 400;
const LONG_RUN_WAIT_MS   = 420 * 1000;
// DealHive 4 (Zillow FSBO by ZIP): pay-per-result actor (~$2.70/1k), so
// spend ≈ zips × per-zip cap. 14-day window keeps the feed stocked even
// though we rebuild it nightly.
const ZILLOW_MAX        = parseInt(process.env.ZILLOW_MAX        || "300", 10);
const ZILLOW_PER_ZIP    = parseInt(process.env.ZILLOW_PER_ZIP    || "15",  10);
const ZILLOW_MAX_AGE_H  = parseInt(process.env.ZILLOW_MAX_AGE_H  || "336", 10);
// The actor can't work all ~44 zips inside one 400s run (a full-list night
// yielded 0 items), so each night takes a 12-zip bite of the daily-rotated
// list — the whole list gets swept every ~4 nights.
const ZILLOW_ZIPS_PER_RUN = parseInt(process.env.ZILLOW_ZIPS_PER_RUN || "12", 10);

// Metros the FSBO.com actor searches ("City, ST", 100-mile radius each) — a
// dozen well-spread hubs blanket the same cash-flow geography the old
// 31-city list did. Browser-scraping cost scales with this list, and it's
// env-tunable for live adjustment.
const FSBO_LOCATIONS = (process.env.FSBO_LOCATIONS || [
  "Cleveland, OH",     // + Akron / Canton / Youngstown
  "Columbus, OH",      // + Dayton / Cincinnati
  "Detroit, MI",       // + Flint / Toledo
  "Memphis, TN",
  "Birmingham, AL",    // + Huntsville
  "Indianapolis, IN",
  "Kansas City, MO",
  "St. Louis, MO",
  "Pittsburgh, PA",
  "Philadelphia, PA",  // + Baltimore
  "Milwaukee, WI",
  "Tampa, FL",         // + Orlando / St. Pete
  "San Antonio, TX",   // + Austin
].join("|")).split("|").map(s => s.trim()).filter(Boolean);

// Investor-grade ZIPs for the Zillow FSBO actor — it's ZIP-driven, unlike
// the metro-driven FSBO.com actor above. Two-ish zips per cash-flow metro;
// spend scales with this list × ZILLOW_PER_ZIP.
const ZILLOW_ZIPS = (process.env.ZILLOW_ZIPS || [
  "44105","44110","44120",      // Cleveland
  "43211","43207",              // Columbus
  "43605","43608",              // Toledo
  "45402","45417",              // Dayton
  "48205","48227","48224",      // Detroit
  "48503",                      // Flint
  "38109","38127","38118",      // Memphis
  "37411",                      // Chattanooga
  "35208","35218",              // Birmingham
  "35805",                      // Huntsville
  "36108",                      // Montgomery
  "46201","46218",              // Indianapolis
  "46806",                      // Fort Wayne
  "64130","64128",              // Kansas City
  "63115","63120",              // St. Louis
  "15210","15221",              // Pittsburgh
  "19132","19140",              // Philadelphia
  "53206","53216",              // Milwaukee
  "21215","21223",              // Baltimore
  "32209",                      // Jacksonville
  "33612",                      // Tampa
  "73111",                      // Oklahoma City
  "74106",                      // Tulsa
  "40211",                      // Louisville
  "72204",                      // Little Rock
  "27405",                      // Greensboro
  "28301",                      // Fayetteville
  "30901",                      // Augusta
  "31206",                      // Macon
  "78207","78228",              // San Antonio
  "78744",                      // Austin
].join(",")).split(",").map(s => s.trim()).filter(Boolean);

// Effective property-tax rates by state (annual % of value). Used by
// classifyDeal — the previous code applied Ohio's 2.33% to every deal, which
// wildly distorted buy-and-hold math in low-tax states (AL 0.41%, CO 0.51%).
const STATE_TAX_RATES = {
  AL:0.0041, AK:0.0119, AZ:0.0066, AR:0.0061, CA:0.0075,
  CO:0.0051, CT:0.0214, DE:0.0061, DC:0.0056, FL:0.0089,
  GA:0.0092, HI:0.0028, ID:0.0069, IL:0.0227, IN:0.0085,
  IA:0.0157, KS:0.0141, KY:0.0086, LA:0.0055, ME:0.0136,
  MD:0.0109, MA:0.0123, MI:0.0154, MN:0.0112, MS:0.0081,
  MO:0.0097, MT:0.0084, NE:0.0173, NV:0.0060, NH:0.0218,
  NJ:0.0249, NM:0.0080, NY:0.0173, NC:0.0084, ND:0.0098,
  OH:0.0156, OK:0.0090, OR:0.0093, PA:0.0158, RI:0.0163,
  SC:0.0057, SD:0.0132, TN:0.0071, TX:0.0181, UT:0.0066,
  VT:0.0190, VA:0.0082, WA:0.0098, WV:0.0058, WI:0.0185, WY:0.0061,
};
const DEFAULT_TAX_RATE = 0.011; // national avg, fallback when state unknown

// Clean, consistent display title for a deal — replaces source-specific
// marketing titles (InvestorLift uses emojis + ALL CAPS, propwire/seibs may
// have their own quirks). Format: "{beds}-bed {type} in {City}, {ST}".
function generateDealTitle({beds, type, city, state}) {
  const t    = type || "Property";
  const lead = beds && beds > 0 ? `${beds}-bed ${t}` : t;
  const loc  = city ? ` in ${city}${state ? `, ${state}` : ""}` : "";
  return `${lead}${loc}`;
}

// -- Source: Apify InvestorLift scraper ---------------------------------------
// Returns {items, debug}. The debug field is surfaced in the /pullDealsNow
// response so we can diagnose schema/auth/empty-result issues without
// crawling Cloud Logging.
async function pullFromApify(token, maxItems) {
  if (!token) return {items: [], debug: {error: "APIFY_API_KEY not set"}, ok: false};
  const actor = "corent1robert~investorlift-scraper";
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${token}&memory=1024`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({maxItems, enrichWithDetails: true, dealIds: []}),
    });
  } catch (e) {
    return {items: [], debug: {error: `fetch threw: ${e.message}`}, ok: false};
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    return {items: [], debug: {httpStatus: res.status, body}, ok: false};
  }
  let parsed;
  try { parsed = await res.json(); } catch (e) {
    return {items: [], debug: {error: `JSON parse failed: ${e.message}`}, ok: false};
  }
  if (!Array.isArray(parsed)) {
    return {items: [], debug: {nonArrayPayload: Object.keys(parsed || {}).slice(0, 30)}, ok: false};
  }
  const rawCount = parsed.length;
  // Capture the shape of the first item — field names only, no values, so we
  // can update mapApifyDeal without exposing scraped seller data in chat.
  const sampleKeys = parsed[0] ? Object.keys(parsed[0]).slice(0, 50) : [];
  const items = parsed.map(mapApifyDeal).filter(Boolean);
  return {
    items,
    debug: {
      httpStatus: res.status,
      rawCount,
      mappedCount: items.length,
      droppedCount: rawCount - items.length,
      sampleKeys,
      // First item's actual values for safe fields — lets us debug type
      // coercion issues (e.g. price arriving as "$79,900" instead of a number).
      sampleValues: parsed[0] ? {
        id:            parsed[0].id,
        price:         parsed[0].price,
        priceType:     typeof parsed[0].price,
        city:          parsed[0].city,
        state_code:    parsed[0].state_code,
        title:         parsed[0].title,
        property_type: parsed[0].property_type,
        bedrooms:      parsed[0].bedrooms,
        bedroomsType:  typeof parsed[0].bedrooms,
      } : null,
    },
    ok: true,
  };
}

// Maps an InvestorLift item (via Apify) into our internal deal shape.
// InvestorLift only exposes city/state/zip publicly — exact street addresses
// are gated behind their login + NDA, so the actor returns a marketing
// `title` instead and the wholesaler's name/company as the contact. We
// surface that on the card; users click through to InvestorLift to get the
// address and contact info after expressing interest.
function mapApifyDeal(raw) {
  // Apify scrapers often hand back prices as formatted strings ("$79,900")
  // rather than numbers — Number() chokes on that and returns NaN. Strip
  // anything that isn't a digit or dot, then parse.
  const price = parseLoose(raw.price);
  const city  = raw.city || "";
  const state = normalizeState(raw.state_code || raw.state);
  if (!price || !city) return null;

  return {
    id:        "il-" + (raw.id || hashId(`${raw.title || ""}|${city}|${raw.zip || ""}`)),
    source:    "DealHive 1", // InvestorLift via Apify (corent1robert~investorlift-scraper)
    sourceUrl: raw.property_page_url || null,
    // `published_at` is ISO ("2026-05-26T12:34:56Z") — slice to date for display.
    sourcedAt: raw.published_at ? String(raw.published_at).slice(0, 10) : today(),
    // Title is a marketing line ("Cleveland off-market BRRRR opportunity") —
    // the most location info available since the street address is gated.
    // Clean, consistent display title — we generate our own rather than
    // surfacing InvestorLift's marketing copy (emojis, ALL CAPS).
    address:   generateDealTitle({
      beds:  int(raw.bedrooms),
      type:  normalizeType(raw.property_type),
      city,
      state,
    }),
    city,
    state,
    zip:       String(raw.zip || ""),
    lat:       num(raw.latitude),
    lng:       num(raw.longitude),
    type:      normalizeType(raw.property_type),
    beds:      int(raw.bedrooms),
    baths:     num(raw.bathrooms),
    sqft:      int(raw.sq_footage),
    yearBuilt: int(raw.year_built),
    price,
    repair:    0, // InvestorLift doesn't publish a rehab number; user runs it through the analyzer
    rent:      0, // 1% rule fallback in classifyDeal fills this for the buyhold score
    arv:       int(raw.arv_estimate),
    photo:     raw.img_url || null,
    // Gallery support — actor currently returns one hero image, but the
    // client renders a carousel that scales to N photos so this is ready
    // when we either upgrade the actor or add a second-pass per-deal pull.
    photos:    raw.img_url ? [raw.img_url] : [],
    seller: {
      name:    raw.wholesaler_name || raw.account_title || null,
      company: raw.wholesaler_company || null,
      // InvestorLift gates phone/email behind their login — clicking the
      // sourceUrl is how the buyer actually gets in touch.
      phone:   null,
      email:   null,
    },
    market: marketIdForState(state),
    // Bonus metadata the Deals page can surface to make Network cards stand
    // out vs. RentCast listings (description, freshness, "hotness" hint).
    description:  raw.description ? String(raw.description).slice(0, 500) : null,
    daysListed:   int(raw.days_on_il),
    hotness:      raw.hotness || null,
  };
}

// -- Source: DealHive 2 (dainty_screw/real-estate-fsbo-com-data-scraper) ------
// FSBO.com by-owner listings around our target metros — thin inventory per
// city, but sellers publish their own contact info, which is the whole draw.
// Browser-based actor (headless Chromium + residential proxies), so unlike
// the API-style sources it can outlive run-sync's 300s ceiling: start the
// run, poll its status, then fetch the dataset. Input mirrors the actor's
// published JSON example.
// Start an actor run, poll to a terminal state (or our own deadline), then
// collect whatever the dataset holds — a TIMED-OUT run still yields its
// partial harvest.
async function apifyRunCollect(token, actor, input, {memory, timeoutS, waitMs}) {
  let run;
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/${actor}/runs?token=${token}&memory=${memory}&timeout=${timeoutS}`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(input),
      });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.data || !body.data.id) {
      return {parsed: null, status: null, debug: {httpStatus: res.status, body: JSON.stringify(body).slice(0, 400)}};
    }
    run = body.data;
  } catch (e) {
    return {parsed: null, status: null, debug: {error: `run start threw: ${e.message}`}};
  }

  const deadline = Date.now() + waitMs;
  let status = run.status;
  while (!["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"].includes(status)) {
    if (Date.now() > deadline) break;
    await new Promise(resolve => setTimeout(resolve, 10 * 1000));
    try {
      const r = await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${token}`);
      const b = await r.json();
      status = (b.data && b.data.status) || status;
    } catch { /* transient poll failure — keep waiting */ }
  }

  let parsed = [];
  try {
    const r = await fetch(
      `https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${token}&clean=true&format=json`);
    if (r.ok) parsed = await r.json();
  } catch { /* fall through with empty */ }
  if (!Array.isArray(parsed)) parsed = [];
  return {parsed, status, debug: {runId: run.id, runStatus: status}};
}

// Long runs process their target list in order, so a timed-out night would
// starve the tail of the list forever. Rotating the starting point daily
// makes weekly coverage complete even when individual runs get cut short.
function rotateDaily(list) {
  if (!list.length) return list;
  const off = Math.floor(Date.now() / 86400000) % list.length;
  return [...list.slice(off), ...list.slice(0, off)];
}

async function pullFromFsbo(token, maxItems) {
  if (!token) return {items: [], debug: {error: "APIFY_API_KEY not set"}, ok: false};
  const {parsed, status, debug} = await apifyRunCollect(
    token, "dainty_screw~real-estate-fsbo-com-data-scraper", {
      searchQueries:       rotateDaily(FSBO_LOCATIONS),
      distanceMiles:       100,
      headless:            true,
      stopOnDuplicatePage: true,
      debugLogPages:       false,
      proxyConfiguration:  {apifyProxyGroups: ["RESIDENTIAL"]},
    }, {memory: 4096, timeoutS: LONG_RUN_TIMEOUT_S, waitMs: LONG_RUN_WAIT_MS});
  if (!parsed) return {items: [], debug, ok: false};

  const mapped = parsed.map(mapFsboDeal).filter(Boolean);
  const items  = mapped.slice(0, maxItems);
  const first  = parsed[0];
  return {
    items,
    debug: {
      ...debug,
      rawCount:     parsed.length,
      mappedCount:  mapped.length,
      keptCount:    items.length,
      droppedCount: parsed.length - mapped.length,
      sampleKeys:   first ? Object.keys(first).slice(0, 60) : [],
      sampleValues: first ? sampleValuePeek(first) : null,
      // Image-element shape probe: string URLs vs {url:...} objects.
      sampleImage:  first && Array.isArray(first.images) && first.images.length
        ? (typeof first.images[0] === "string"
          ? first.images[0].slice(0, 140)
          : Object.keys(first.images[0] || {}).slice(0, 8))
        : null,
    },
    ok: status === "SUCCEEDED" || items.length > 0,
  };
}

// FSBO.com's detail schema gets confirmed by the first live run (sampleKeys/
// sampleValues in the debug payload). Until then this mapper probes the
// common field spellings and drops anything it can't price and place.
function mapFsboDeal(raw) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = raw[k];
      if (v != null && v !== "") return v;
    }
    return null;
  };
  const price      = parseLoose(pick("price", "listPrice", "askingPrice", "listingPrice"));
  const addrText   = pick("address1", "address", "fullAddress", "addressFull", "streetAddress", "location");
  const parsedAddr = splitAddress(typeof addrText === "string" ? addrText : "");
  const city  = pick("city") || parsedAddr.city;
  const state = normalizeState(pick("state", "stateCode") || parsedAddr.state);
  if (!price || !city || !state) return null;

  const street = pick("address1", "streetAddress", "street") || parsedAddr.street;
  const photos = pickPhotos(raw);
  const beds   = int(pick("beds", "bedrooms"));
  // FSBO.com is overwhelmingly single-family; the default keeps
  // isResidential from dropping rows if the run reveals no type field.
  const type   = normalizeType(pick("propertyType", "homeType", "type") || "Single Family");
  // fsbo.com sends `seller` as the owner's display name; tolerate an
  // object shape too since the schema is actor-defined.
  const sellerRaw = raw.seller;
  const name  = (typeof sellerRaw === "string" && sellerRaw.trim())
    || (sellerRaw && typeof sellerRaw === "object" && (sellerRaw.name || sellerRaw.fullName))
    || pick("contactName", "sellerName", "ownerName", "listedBy");
  const phone = pick("phone", "phoneNumber", "contactPhone", "sellerPhone", "ownerPhone")
    || (sellerRaw && typeof sellerRaw === "object" ? sellerRaw.phone : null);
  const email = pick("email", "contactEmail")
    || (sellerRaw && typeof sellerRaw === "object" ? sellerRaw.email : null);

  return {
    id:        "f2-" + hashId(`${street || (typeof addrText === "string" ? addrText : "")}|${city}|${state}`),
    source:    "DealHive 2", // FSBO.com
    sourceUrl: null, // never link out
    sourcedAt: today(),
    address:       generateDealTitle({beds, type, city, state}),
    streetAddress: street,
    city,
    state,
    zip:       String(pick("zip", "zipcode", "zipCode", "postalCode") || parsedAddr.zip || ""),
    lat:       num(pick("latitude", "lat")),
    lng:       num(pick("longitude", "lng", "lon")),
    type,
    beds,
    baths:     (() => {
      const full = num(pick("baths", "bathrooms", "bathroomsFull"));
      const half = num(raw.bathroomsHalf);
      return full || half ? (full || 0) + (half || 0) * 0.5 : null;
    })(),
    sqft:      int(pick("sqft", "squareFeet", "squareFootage", "livingArea")),
    yearBuilt: int(pick("yearBuilt", "year_built")),
    lotSize:   int(pick("lotSize", "lotSqft", "lot_sqft")),
    price,
    repair:    0, // owner listings; classifyDeal applies its default rehab
    rent:      0, // classifyDeal's 1% rule fallback scores buy & hold
    arv:       0, // classifyDeal falls back to price × 1.30
    photo:     photos[0] || null,
    photos,
    // By-owner: the seller IS the owner, and FSBO.com sellers publish their
    // own contact — the reason this source earns its slot.
    seller: (phone || name || email) ? {
      name:    typeof name === "string" ? name.slice(0, 80) : null,
      company: null,
      phone:   phone != null ? String(phone).slice(0, 30) : null,
      email:   typeof email === "string" ? email.slice(0, 120) : null,
    } : null,
    market:      marketIdForState(state),
    // Unlike InvestorLift's, fsbo.com blurbs are the owner's own pitch for
    // their house — real Deal View context. Same 500-char cap as the rest.
    description: raw.description ? String(raw.description).slice(0, 500) : null,
  };
}

// "123 Main St, Tampa, FL 33604" / "Tampa, FL" → address parts.
function splitAddress(s) {
  const m = String(s).match(/^\s*(?:(.*?),\s*)?([A-Za-z .'-]+),\s*([A-Za-z]{2})\b\s*(\d{5})?/);
  if (!m) return {street: null, city: null, state: null, zip: null};
  return {street: m[1] || null, city: m[2] ? m[2].trim() : null, state: m[3] || null, zip: m[4] || null};
}

// Shared photo-extraction across the new sources (schemas vary; try common shapes).
function pickPhotos(raw) {
  if (Array.isArray(raw.photos))      return raw.photos.map(photoUrl).filter(Boolean);
  if (Array.isArray(raw.images))      return raw.images.map(photoUrl).filter(Boolean);
  if (Array.isArray(raw.image_urls))  return raw.image_urls.filter(Boolean);
  const single = raw.photo_url || raw.image_url || raw.img_url || raw.thumbnail || raw.mlsPhotoUrl || null;
  return single ? [single] : [];
}
function photoUrl(p) { return typeof p === "string" ? p : (p && (p.url || p.src || p.href)) || null; }

// Strip values to a safe slice (first ~40 fields, truncated strings) for the
// debug payload — enough to debug schema/coercion without leaking large blobs.
function sampleValuePeek(obj) {
  const out = {};
  let n = 0;
  for (const k of Object.keys(obj)) {
    if (n++ >= 40) break;
    const v = obj[k];
    if (v == null) { out[k] = v; continue; }
    if (typeof v === "string") out[k] = v.slice(0, 80);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v)) out[k] = `Array(${v.length})`;
    else out[k] = `Object(${Object.keys(v).slice(0,3).join(",")}...)`;
    out[k + "_type"] = typeof v;
  }
  return out;
}

// -- Source: RentCast public listings -----------------------------------------
async function pullFromRentCast(key, market, limit) {
  if (!key) return [];
  const propertyTypes = "Single Family,Multi-Family,Townhouse,Condo";
  const url =
    `https://api.rentcast.io/v1/listings/sale` +
    `?city=${encodeURIComponent(market.city)}` +
    `&state=${market.state}` +
    `&propertyType=${encodeURIComponent(propertyTypes)}` +
    `&status=Active&limit=${limit}`;
  const res = await fetch(url, {headers: {"X-Api-Key": key}});
  if (!res.ok) {
    logger.warn(`RentCast ${market.id} HTTP ${res.status}`);
    return [];
  }
  const data = await res.json();
  const arr  = Array.isArray(data) ? data : (data.listings || []);
  return arr.map(l => mapRentCastListing(l, market)).filter(Boolean);
}

function mapRentCastListing(raw, market) {
  // RentCast formats addresses as "123 Main St, Cleveland, OH 44102" —
  // split out the street part for display.
  const addrFull = raw.formattedAddress || "";
  const address  = addrFull.split(",")[0] || raw.addressLine1 || "";
  const price    = Number(raw.price || raw.listPrice || 0);
  if (!address || !price) return null;

  // ARV proxy: RentCast doesn't return a separate after-repair number for
  // for-sale listings. Use the listing price + 25% as a rough ARV ceiling.
  // The user can override per-deal in the analyzer once they pull comps.
  const arv = Math.round(price * 1.25);

  return {
    id:        hashId("rc-" + addrFull),
    source:    "RentCast",
    sourceUrl: raw.listingUrl || null,
    sourcedAt: today(),
    address,
    city:      raw.city  || market.city,
    state:     raw.state || market.state,
    zip:       String(raw.zipCode || raw.zip || ""),
    lat:       num(raw.latitude),
    lng:       num(raw.longitude),
    type:      normalizeType(raw.propertyType),
    beds:      int(raw.bedrooms),
    baths:     num(raw.bathrooms),
    sqft:      int(raw.squareFootage),
    yearBuilt: int(raw.yearBuilt),
    price,
    repair:    0, // public listings don't include rehab estimates
    rent:      int(raw.rentEstimate),
    arv,
    photo:     (Array.isArray(raw.photos) && raw.photos[0]?.url) || raw.photoUrl || null,
    seller:    null, // RentCast doesn't expose listing-agent contact via this endpoint
    market:    market.id,
  };
}

// -- Filtering / classification / dedup ---------------------------------------
function isResidential(deal) { return RESIDENTIAL_TYPES.has(deal.type); }

// Same scoring rules as classifyDeal() in src/App.jsx — duplicated here so the
// function has no client deps. Both must stay in sync; if you tune one, tune
// the other (or extract to a shared package later).
function classifyDeal(deal) {
  // Rent estimate — prefer real value, else 1% rule capped at $2,200 to avoid
  // optimistic numbers on expensive properties.
  const rent       = deal.rent && deal.rent > 0
    ? deal.rent
    : Math.min(2200, Math.round((deal.price || 0) * 0.01));
  // ARV — prefer scraped value, else 30% margin over asking.
  const arv        = deal.arv && deal.arv > 0 ? deal.arv : Math.round((deal.price || 0) * 1.30);
  // Repair budget — wholesale deals need work. If the source doesn't tell us
  // anything, assume 15% of ARV (standard for a "B" rehab).
  const repair     = deal.repair && deal.repair > 0 ? deal.repair : Math.round(arv * 0.15);

  // State-specific effective property tax. Was Ohio's 2.33% on every deal.
  const taxRate    = STATE_TAX_RATES[deal.state] || DEFAULT_TAX_RATE;
  const monthlyTax = Math.round((deal.price * taxRate) / 12);

  // Buy-and-hold pro forma — 80% LTV @ 7.5% over 30 yrs, real expenses.
  const PI         = monthlyPI(deal.price * 0.8, 7.5);
  const exp        = monthlyTax + 100 /* insurance */ + Math.round(rent * 0.08) /* 8% PM */;
  const effRent    = rent * 0.95; // 5% vacancy
  const finCF      = effRent - exp - PI;
  const noi        = (effRent - exp) * 12;
  const finCap     = deal.price > 0 ? (noi / deal.price) * 100 : 0;

  // Fix-and-flip — ARV less total-in, 6% agent + 2% closing on the sale, plus
  // 6 months of holding (taxes + insurance + utilities).
  const totalIn      = (deal.price || 0) + repair;
  const sellingCosts = arv * 0.08;
  const holdingCost  = 6 * (monthlyTax + 500 /* ins + utilities + misc */);
  const flipProfit   = Math.round(arv - totalIn - sellingCosts - holdingCost);
  const flipROI      = totalIn > 0 ? (flipProfit / totalIn) * 100 : 0;

  // Tighter gates — users complained about $30/mo cash-flow deals making the
  // list. We're selling these leads, so only "good" passes.
  //   Buy-and-hold: cap >= 8% AND >= $200/mo cash flow
  //   Fix-and-flip: ROI >= 18% AND >= $25k profit
  const tags = [];
  if (finCap >= 8   && finCF      >= 200)   tags.push("buyhold");
  if (flipROI >= 18 && flipProfit >= 25000) tags.push("flip");
  return tags;
}

function monthlyPI(principal, rate) {
  if (!principal || !rate) return 0;
  const r = rate / 100 / 12, n = 30 * 12;
  return principal * (r * Math.pow(1+r, n)) / (Math.pow(1+r, n) - 1);
}

function dedupByAddress(deals) {
  const seen = new Map();
  for (const d of deals) {
    const key = `${(d.address||"").toLowerCase().replace(/\s+/g," ").trim()}|${(d.city||"").toLowerCase().trim()}`;
    if (!seen.has(key)) { seen.set(key, d); continue; }
    // Same property from two sources — keep whichever is richer (seller > photo).
    const old = seen.get(key);
    const score = x => (x.seller && (x.seller.phone || x.seller.email) ? 2 : 0) + (x.photo ? 1 : 0);
    if (score(d) > score(old)) seen.set(key, d);
  }
  return [...seen.values()];
}

// -- Small helpers ------------------------------------------------------------
function today() { return new Date().toISOString().slice(0, 10); }
function num(v)  { const n = parseLoose(v); return Number.isFinite(n) && n !== 0 ? n : null; }
function int(v)  { const n = Math.round(parseLoose(v)); return Number.isFinite(n) ? n : 0; }
// Tolerates numbers, integer-as-strings, and formatted strings like "$79,900".
function parseLoose(v) {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const cleaned = String(v).replace(/[^\d.\-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}
function pickFirst(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const x = arr[0];
  return typeof x === "string" ? x : (x.url || x.src || x.href || null);
}
function normalizeState(s) {
  if (!s) return "";
  const v = String(s).trim().toUpperCase();
  // Allow full state names through a tiny map; everything else gets the first 2 chars.
  const map = {OHIO:"OH", MICHIGAN:"MI", TENNESSEE:"TN", ALABAMA:"AL", INDIANA:"IN", MISSOURI:"MO"};
  return map[v] || v.slice(0, 2);
}
function normalizeType(s) {
  if (!s) return "Single Family"; // most generous default; isResidential() decides
  const v = String(s).toLowerCase();
  if (v.includes("single") || v === "sfr" || v === "sfh")                            return "Single Family";
  if (v.includes("duplex") || v.includes("triplex") || v.includes("fourplex")
      || v.includes("multi") || v.includes("2-4") || v.includes("2 to 4"))           return "Multi-Family";
  if (v.includes("town"))                                                            return "Townhouse";
  if (v.includes("condo"))                                                           return "Condo";
  // fsbo.com-style labels ("House", "Home") — townhouse is already caught.
  if (v.includes("house") || v === "home" || v.includes("residential"))              return "Single Family";
  // Land, Commercial, Apartment (5+), Manufactured — leave as-is and let
  // isResidential() drop them.
  return s;
}
function marketIdForState(state) {
  const m = MARKETS.find(x => x.state === state);
  return m ? m.id : null;
}
function hashId(s) {
  // Stable, address-derived ID — same property → same id across runs, so the
  // /deals/{id} entry updates in place rather than creating duplicates.
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return "d" + Math.abs(h).toString(36);
}

// -- Pipeline -----------------------------------------------------------------
// `rentcastKey` is still accepted for backward-compat (and could be re-enabled
// by un-commenting the call below) but is intentionally not used: RentCast
// surfaces generic public listings with no photos, which dilutes the Deals
// page. Sticking to the exclusive InvestorLift Network feed only.
// -- Source: DealHive 4 (ayk_6789/zillow-new-listings-scraper via Apify) -------
// Zillow FSBO listings by ZIP — the address-rich, photo-rich off-market
// source. 44 zips outgrow run-sync's 300s ceiling, so it goes through the
// same start -> poll -> collect runner as FSBO.com.
async function pullFromZillow(token, maxItems) {
  if (!token) return {items: [], debug: {error: "APIFY_API_KEY not set"}, ok: false};
  const {parsed, status, debug} = await apifyRunCollect(
    token, "ayk_6789~zillow-new-listings-scraper", {
      zipCodes:           rotateDaily(ZILLOW_ZIPS).slice(0, ZILLOW_ZIPS_PER_RUN),
      listingTypes:       ["fsbo"],
      maxListingAgeHours: ZILLOW_MAX_AGE_H,
      maxListingsPerZip:  ZILLOW_PER_ZIP,
      deduplicateResults: true,
    }, {memory: 1024, timeoutS: LONG_RUN_TIMEOUT_S, waitMs: LONG_RUN_WAIT_MS});
  if (!parsed) return {items: [], debug, ok: false};

  const mapped = parsed.map(mapZillowDeal).filter(Boolean);
  const items  = mapped.slice(0, maxItems);
  return {
    items,
    debug: {
      ...debug,
      rawCount:     parsed.length,
      mappedCount:  mapped.length,
      keptCount:    items.length,
      droppedCount: parsed.length - mapped.length,
      sampleKeys:   parsed[0] ? Object.keys(parsed[0]).slice(0, 60) : [],
    },
    ok: status === "SUCCEEDED" || items.length > 0,
  };
}

const ZILLOW_TYPE_MAP = {
  SINGLE_FAMILY: "Single Family",
  MULTI_FAMILY:  "Multi-Family",
  TOWNHOUSE:     "Townhouse",
  CONDO:         "Condo",
  APARTMENT:     "Multi-Family",
};

function mapZillowDeal(raw) {
  const price = parseLoose(raw.price);
  const city  = raw.city || "";
  const state = normalizeState(raw.state);
  if (!price || !city || !state) return null;
  if (raw.is_pending) return null;

  const street = raw.street || raw.address_full || null;
  const photos = (Array.isArray(raw.carousel_photos) && raw.carousel_photos.length
    ? raw.carousel_photos
    : (raw.photo_url ? [raw.photo_url] : [])).filter(Boolean);
  const beds = int(raw.beds);
  const type = ZILLOW_TYPE_MAP[raw.home_type] || normalizeType(raw.home_type);

  return {
    id:        "z4-" + (raw.zpid || hashId(`${street || ""}|${city}|${state}`)),
    source:    "DealHive 4", // Zillow FSBO
    sourceUrl: null, // never link out
    sourcedAt: today(),
    address:       generateDealTitle({beds, type, city, state}),
    streetAddress: street,
    city,
    state,
    zip:       String(raw.zip || ""),
    lat:       num(raw.lat),
    lng:       num(raw.lng),
    type,
    beds,
    baths:     num(raw.baths),
    sqft:      int(raw.sqft),
    yearBuilt: int(raw.year_built),
    lotSize:   int(raw.lot_sqft),
    price,
    repair:    0, // owner listings; classifyDeal applies its default rehab
    // Zillow's own rent estimate rides along — better than the 1% fallback.
    rent:      int(raw.rent_zestimate),
    arv:       int(raw.zestimate),
    photo:     photos[0] || null,
    photos,
    // FSBO means the owner IS the seller, but this actor exposes no contact
    // details — the full address is the value here.
    seller:    null,
    market:    marketIdForState(state),
    description: null,
  };
}

async function runPipeline(apifyKey, _rentcastKey) {
  const sources = {investorlift: 0, dealhive2: 0, dealhive4: 0};
  const errors  = {investorlift: false, dealhive2: false, dealhive4: false};
  const debug   = {};
  const raw     = [];

  // Pulls run in parallel. The API-style actors take 1-3 minutes; FSBO.com
  // drives a real browser and polls up to ~7, all inside this function's
  // 540s ceiling. Combined actor memory (1 + 4 + 1 GB) stays well under
  // Apify's 8GB account ceiling.
  if (!apifyKey) {
    errors.investorlift = errors.dealhive2 = errors.dealhive4 = true;
    debug.apify = debug.fsbo = debug.zillow = {error: "APIFY_API_KEY not set"};
  } else {
    const sourceTasks = [
      {
        name:     "investorlift",
        debugKey: "apify",
        label:    "InvestorLift",
        run:      () => pullFromApify(apifyKey, INVESTORLIFT_MAX),
      },
      {
        name:     "dealhive2",
        debugKey: "fsbo",
        label:    "FSBO.com (DealHive 2)",
        run:      () => pullFromFsbo(apifyKey, FSBO_MAX),
      },
      {
        name:     "dealhive4",
        debugKey: "zillow",
        label:    "zillow FSBO (DealHive 4)",
        run:      () => pullFromZillow(apifyKey, ZILLOW_MAX),
      },
    ];

    const settled = await Promise.all(sourceTasks.map(t =>
      t.run().then(
        r => ({task: t, result: r, threw: null}),
        err => ({task: t, result: null, threw: err}),
      ),
    ));

    for (const {task, result, threw} of settled) {
      if (threw) {
        errors[task.name] = true;
        debug[task.debugKey] = {error: threw.message};
        logger.error(`Apify ${task.label} pull failed`, {error: threw.message});
        continue;
      }
      const {items, debug: d, ok} = result;
      sources[task.name] = items.length;
      raw.push(...items);
      debug[task.debugKey] = d;
      if (!ok) errors[task.name] = true;
      logger.info(`Apify ${task.label}: ${d.rawCount || 0} raw, ${items.length} mapped, ok=${ok}`, d);
    }
  }

  // 3. Filter to residential + only deals that score on at least one strategy.
  const scored  = raw
    .filter(isResidential)
    .map(d => ({d, tags: classifyDeal(d)}))
    .filter(({tags}) => tags.length > 0);
  const deduped = dedupByAddress(scored.map(({d}) => d));

  // 4. Safety net: only skip the write if every source ERRORED. If Apify
  // ran but returned 0 mappable items, that's a legitimate "no deals
  // right now" — we still write empty so stale data doesn't linger.
  const allErrored = Object.values(errors).every(Boolean);
  if (allErrored) {
    logger.warn("All sources errored — leaving existing /deals untouched.");
    return {written: 0, raw: 0, sources, debug, skipped: true};
  }

  // `sources` counts RAW pulls; written-per-source is what actually shipped
  // to the page — the number to check when a source seems missing.
  const writtenBySource = {};
  deduped.forEach(d => {
    const k = d.source || "unknown";
    writtenBySource[k] = (writtenBySource[k] || 0) + 1;
  });
  const itemsMap = Object.fromEntries(deduped.map(d => [d.id, d]));
  await admin.database().ref("/deals").set({
    updatedAt: Date.now(),
    count:     deduped.length,
    sources,
    writtenBySource,
    items:     itemsMap,
  });

  logger.info(`✓ Wrote ${deduped.length} deals (raw ${raw.length})`, {sources, writtenBySource});
  return {written: deduped.length, raw: raw.length, sources, writtenBySource, debug, skipped: false};
}

// -- Triggers -----------------------------------------------------------------
exports.pullDeals = onSchedule({
  schedule:       "every day 06:00",
  timeZone:       "America/New_York",
  timeoutSeconds: 540,
  memory:         "512MiB",
  secrets:        [APIFY_API_KEY, RENTCAST_API_KEY],
}, async () => {
  await runPipeline(APIFY_API_KEY.value(), RENTCAST_API_KEY.value());
});

// HTTPS trigger for ad-hoc runs — auth via shared secret in the query string.
// Useful right after deploy to verify the pipeline without waiting overnight.
//   curl "https://us-central1-darallc.cloudfunctions.net/pullDealsNow?secret=XXXX"
// -- RentCast proxy for the app --------------------------------------------------
// Signed-in users (Firebase ID token) can query a small allowlist of RentCast
// endpoints through the server key — no client-side API key ever. Per-user
// daily cap protects the RentCast bill from a misbehaving client.
const RC_ALLOWED = [
  /^\/properties\?/,
  /^\/avm\/value\?/,
  /^\/avm\/rent\/long-term\?/,
  /^\/listings\/rental\/long-term\?/,
  /^\/listings\/sale\?/,
];
const RC_DAILY_CAP = 150;

exports.rcProxy = onRequest(
  {secrets: [RENTCAST_API_KEY], cors: true, region: "us-central1", timeoutSeconds: 30},
  async (req, res) => {
    try {
      const authz = String(req.headers.authorization || "");
      const tok = authz.startsWith("Bearer ") ? authz.slice(7) : null;
      if (!tok) { res.status(401).json({error: "auth"}); return; }
      const decoded = await admin.auth().verifyIdToken(tok).catch(() => null);
      if (!decoded) { res.status(401).json({error: "auth"}); return; }

      const path = String(req.query.path || "");
      if (!RC_ALLOWED.some(rx => rx.test(path))) { res.status(400).json({error: "path"}); return; }

      const day = new Date().toISOString().slice(0, 10);
      const ref = admin.database().ref(`rcUsage/${decoded.uid}/${day}`);
      const tx  = await ref.transaction(v => (v || 0) + 1);
      if ((tx.snapshot.val() || 0) > RC_DAILY_CAP) { res.status(429).json({error: "cap"}); return; }

      const r = await fetch("https://api.rentcast.io/v1" + path, {
        headers: {"X-Api-Key": RENTCAST_API_KEY.value()},
      });
      const body = await r.text();
      res.status(r.status).set("Content-Type", "application/json").send(body);
    } catch (e) {
      logger.error("rcProxy", e);
      res.status(500).json({error: "proxy"});
    }
  });

exports.pullDealsNow = onRequest({
  timeoutSeconds: 540,
  memory:         "512MiB",
  secrets:        [APIFY_API_KEY, RENTCAST_API_KEY, MANUAL_TRIGGER_SECRET],
}, async (req, res) => {
  const expected = MANUAL_TRIGGER_SECRET.value();
  if (!expected || req.query.secret !== expected) {
    res.status(403).send("Forbidden");
    return;
  }
  try {
    const result = await runPipeline(APIFY_API_KEY.value(), RENTCAST_API_KEY.value());
    res.json(result);
  } catch (e) {
    logger.error("Manual pipeline run failed", {error: e.message});
    res.status(500).json({error: e.message});
  }
});

// == Stripe billing =============================================================
// Pro is a single $29.99/mo subscription. Checkout and the customer portal are
// created server-side (price is pinned by ID — the client can't tamper with
// amounts), and the webhook is the only writer of billing/{uid}, which the app
// treats as the tier authority at sign-in.
//
// Webhook trust model: we never act on the posted payload. We take the event
// id and re-fetch the event from Stripe's API with our key — an attacker
// can't forge that — so no webhook signing secret is needed.
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_PRICE_ID   = "price_1TgDZo02g0ecGMpyP7iKQCpP"; // DealHive Pro, $29.99/mo
const APP_ORIGIN        = "https://dealhive.io";

async function stripeReq(key, method, path, params) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${key}`,
      ...(method === "POST" ? {"Content-Type": "application/x-www-form-urlencoded"} : {}),
    },
    body: method === "POST" && params ? new URLSearchParams(params).toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data.error && data.error.message) || `Stripe ${res.status}`);
  }
  return data;
}

async function verifyUser(req) {
  const authz = String(req.headers.authorization || "");
  const tok = authz.startsWith("Bearer ") ? authz.slice(7) : null;
  if (!tok) return null;
  return admin.auth().verifyIdToken(tok).catch(() => null);
}

const billingRef = (uid) => admin.database().ref(`billing/${uid}`);

// The true tier straight from Stripe: any active/trialing/past_due
// subscription on the customer means Pro. The webhook uses this so a stale
// event about an old (cancelled) subscription can never overwrite a newer
// live one, and syncBilling exposes it for client self-healing.
async function reconcileCustomer(key, uid, customerId) {
  const subs = await stripeReq(key, "GET", `/v1/subscriptions?customer=${customerId}&status=all&limit=20`);
  const list = Array.isArray(subs.data) ? subs.data : [];
  const live = list.filter(s => ["active", "trialing", "past_due"].includes(s.status));
  const best = live[0] || list[0] || null;
  const periodEnd = best ? (best.current_period_end ||
    (best.items && best.items.data && best.items.data[0] &&
     best.items.data[0].current_period_end) || 0) : 0;
  const record = {
    tier: live.length > 0 ? "pro" : "free",
    status: best ? best.status : "none",
    cancelAtPeriodEnd: !!(best && best.cancel_at_period_end),
    currentPeriodEnd: periodEnd * 1000,
    customerId,
    updatedAt: Date.now(),
  };
  await billingRef(uid).update(record);
  return record;
}

exports.createCheckoutSession = onRequest(
  {secrets: [STRIPE_SECRET_KEY], cors: true, region: "us-central1", timeoutSeconds: 30},
  async (req, res) => {
    try {
      if (req.method !== "POST") { res.status(405).json({error: "POST only"}); return; }
      const user = await verifyUser(req);
      if (!user) { res.status(401).json({error: "Sign in first."}); return; }
      const key = STRIPE_SECRET_KEY.value();

      // One Stripe customer per account, reused across checkouts so the
      // subscription, invoices, and portal all hang off a single record.
      let customerId = (await billingRef(user.uid).child("customerId").get()).val();
      if (!customerId) {
        const customer = await stripeReq(key, "POST", "/v1/customers", {
          email: user.email || "",
          "metadata[firebaseUid]": user.uid,
        });
        customerId = customer.id;
        await billingRef(user.uid).update({customerId});
        await admin.database().ref(`stripeCustomers/${customerId}`).set(user.uid);
      }

      const session = await stripeReq(key, "POST", "/v1/checkout/sessions", {
        "mode": "subscription",
        "customer": customerId,
        "line_items[0][price]": STRIPE_PRICE_ID,
        "line_items[0][quantity]": "1",
        "client_reference_id": user.uid,
        "subscription_data[metadata][firebaseUid]": user.uid,
        "allow_promotion_codes": "true",
        "success_url": `${APP_ORIGIN}/?billing=success`,
        "cancel_url": `${APP_ORIGIN}/?billing=cancelled`,
      });
      res.json({url: session.url});
    } catch (e) {
      logger.error("createCheckoutSession", {error: e.message});
      res.status(500).json({error: "Could not start checkout. Try again in a moment."});
    }
  });

exports.createPortalSession = onRequest(
  {secrets: [STRIPE_SECRET_KEY], cors: true, region: "us-central1", timeoutSeconds: 30},
  async (req, res) => {
    try {
      if (req.method !== "POST") { res.status(405).json({error: "POST only"}); return; }
      const user = await verifyUser(req);
      if (!user) { res.status(401).json({error: "Sign in first."}); return; }
      const customerId = (await billingRef(user.uid).child("customerId").get()).val();
      if (!customerId) { res.status(400).json({error: "No billing profile on this account yet."}); return; }
      const session = await stripeReq(STRIPE_SECRET_KEY.value(), "POST", "/v1/billing_portal/sessions", {
        "customer": customerId,
        "return_url": `${APP_ORIGIN}/`,
      });
      res.json({url: session.url});
    } catch (e) {
      logger.error("createPortalSession", {error: e.message});
      res.status(500).json({error: "Could not open the billing portal."});
    }
  });

// Token-gated reconcile — the app calls this at sign-in when a customer's
// record says free, so any webhook race self-heals on the next load.
exports.syncBilling = onRequest(
  {secrets: [STRIPE_SECRET_KEY], cors: true, region: "us-central1", timeoutSeconds: 30},
  async (req, res) => {
    try {
      if (req.method !== "POST") { res.status(405).json({error: "POST only"}); return; }
      const user = await verifyUser(req);
      if (!user) { res.status(401).json({error: "Sign in first."}); return; }
      const customerId = (await billingRef(user.uid).child("customerId").get()).val();
      if (!customerId) { res.json({tier: "free"}); return; }
      const rec = await reconcileCustomer(STRIPE_SECRET_KEY.value(), user.uid, customerId);
      res.json(rec);
    } catch (e) {
      logger.error("syncBilling", {error: e.message});
      res.status(500).json({error: "Could not sync billing."});
    }
  });

exports.stripeWebhook = onRequest(
  {secrets: [STRIPE_SECRET_KEY], region: "us-central1", timeoutSeconds: 30},
  async (req, res) => {
    try {
      const id = req.body && req.body.id;
      if (!id || !/^evt_[A-Za-z0-9_]+$/.test(String(id))) { res.status(400).send("bad event"); return; }
      const key   = STRIPE_SECRET_KEY.value();
      const event = await stripeReq(key, "GET", `/v1/events/${id}`); // authoritative copy
      const obj   = event.data && event.data.object;
      if (!obj) { res.status(200).send("ok"); return; }

      const uidFor = async (customerId, fallbackUid) => {
        if (fallbackUid) return fallbackUid;
        if (!customerId) return null;
        return (await admin.database().ref(`stripeCustomers/${customerId}`).get()).val();
      };

      if (event.type === "checkout.session.completed" && obj.mode === "subscription") {
        const uid = await uidFor(obj.customer, obj.client_reference_id);
        if (uid) {
          await billingRef(uid).update({
            tier: "pro", status: "active",
            customerId: obj.customer,
            subscriptionId: obj.subscription || null,
            updatedAt: Date.now(),
          });
          await admin.database().ref(`stripeCustomers/${obj.customer}`).set(uid);
          logger.info("stripe: pro activated", {uid});
        }
      } else if (event.type === "customer.subscription.updated" ||
                 event.type === "customer.subscription.deleted") {
        const uid = await uidFor(obj.customer, obj.metadata && obj.metadata.firebaseUid);
        if (uid) {
          // Judge the CUSTOMER, not this one event: list every subscription
          // and grant Pro if any is live. Immune to event-ordering races.
          const rec = await reconcileCustomer(key, uid, obj.customer);
          logger.info("stripe: subscription reconciled", {uid, tier: rec.tier, status: rec.status});
        }
      }
      res.status(200).send("ok");
    } catch (e) {
      logger.error("stripeWebhook", {error: e.message});
      res.status(500).send("error"); // non-2xx => Stripe retries, which is what we want
    }
  });
