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
//   firebase functions:secrets:set ENDATO_AP_NAME          (skip trace, optional)
//   firebase functions:secrets:set ENDATO_AP_PASSWORD      (skip trace, optional)
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

// Pull caps — env-tunable for live tuning without redeploy. FSBO.com is the
// feed's sole source: address-rich by-owner listings with seller contact.
const FSBO_MAX          = parseInt(process.env.FSBO_MAX          || "150", 10);
// IL (convertfleet InvestorLift scraper) runs in shadow: capped small, and
// its results are inspected in debug only until addresses verify.
const IL_MAX            = parseInt(process.env.IL_MAX            || "25",  10);
// Nightly budget for fresh RentCast rent lookups during feed underwriting.
// Cached rents are free, so steady-state spend is only never-seen listings.
const RENT_LOOKUPS_MAX  = parseInt(process.env.RENT_LOOKUPS_MAX  || "60",  10);
// Deals that fail at asking get re-underwritten at lower prices down to
// this floor; the highest passing price ships as the Target Offer.
const OFFER_FLOOR_PCT   = parseInt(process.env.OFFER_FLOOR_PCT   || "80",  10);
// The browser actor outgrows run-sync's 300s ceiling, so it runs
// start -> poll -> collect: a server-side kill switch (timeout= on the run
// start) and our poll gives up at LONG_RUN_WAIT_MS, keeping the partial
// harvest either way.
const LONG_RUN_TIMEOUT_S = 400;
const LONG_RUN_WAIT_MS   = 420 * 1000;

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
      // Direct-contact coverage — how many shipped listings carry the
      // owner's phone/email (drives the tap-to-call experience).
      withPhone:    items.filter(i => i.seller && i.seller.phone).length,
      withEmail:    items.filter(i => i.seller && i.seller.email).length,
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

// Deal scoring — the ONE brain. Synced to the analyzer's portal-wide
// assumptions (75% LTV @ 7.5%, 8% vacancy, 8% management of collected rent,
// 5% maintenance + 5% CapEx of gross rent) and STAMPED onto every deal the
// pipeline writes. The app prefers the stamp over re-deriving, so page math
// can never silently disagree with the pipeline about what qualifies.
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

  // The property's attributes are fixed; the PRICE is the variable a real
  // underwriter solves for. `at(price)` runs the full 2x3 matrix at any
  // candidate price (taxes re-based on it; rent, ARV, and rehab are the
  // property's own numbers and stay anchored).
  const ask     = deal.price || 0;
  const closing = 10895; // DEFAULT_CLOSING parity with the analyzer
  const at = (price) => {
  const monthlyTax = Math.round((price * taxRate) / 12);
  const collected  = rent * 0.92;
  const exp        = monthlyTax + 100 + Math.round(collected * 0.08) + Math.round(rent * 0.10);
  const noiMo      = collected - exp;
  const cap        = price > 0 ? (noiMo * 12 / price) * 100 : 0;

  // Buy & Hold, both ways. Financed: 75% LTV @ 7.5%/30yr conventional.
  const PI      = monthlyPI(price * 0.75, 7.5);
  const finCF   = noiMo - PI;
  const finIn   = price * 0.25 + repair + closing;
  const finCoC  = finIn > 0 ? (finCF * 12 / finIn) * 100 : 0;
  const cashCF  = noiMo;
  const cashIn  = price + repair + closing;
  const cashCoC = cashIn > 0 ? (cashCF * 12 / cashIn) * 100 : 0;
  const bhFin   = cap >= 8 && finCF  >= 200;
  const bhCash  = cap >= 8 && cashCF >= 200;

  // Fix & Flip, both ways. Financed: hard money at 75% LTV, 12% interest
  // only for the six-month hold, rehab paid in cash — analyzer defaults.
  const sellingCosts  = arv * 0.08;
  const holdingCost   = 6 * (monthlyTax + 500 /* ins + utilities + misc */);
  const flipInCash    = price + repair;
  const flipProfit    = Math.round(arv - flipInCash - sellingCosts - holdingCost);
  const flipROI       = flipInCash > 0 ? (flipProfit / flipInCash) * 100 : 0;
  const hmInterest    = Math.round(price * 0.75 * 0.12 / 12 * 6);
  const flipInFin     = price * 0.25 + repair;
  const flipProfitFin = flipProfit - hmInterest;
  const flipROIFin    = flipInFin > 0 ? (flipProfitFin / flipInFin) * 100 : 0;
  const flCash = flipROI    >= 18 && flipProfit    >= 25000;
  const flFin  = flipROIFin >= 18 && flipProfitFin >= 25000;

  // BRRRR, both ways. Cash: buy + rehab all cash, refi at 75% of ARV.
  // Financed: hard money buys it and the refinance pays that loan off.
  const refiLoan     = Math.round(arv * 0.75);
  const refiPmt      = monthlyPI(refiLoan, 7.5);
  const brrrrOpEx    = monthlyTax + 100 + Math.round(rent * 0.92 * 0.08) + Math.round(rent * 0.10);
  const brrrrCF      = rent - brrrrOpEx - refiPmt;
  const allInCash    = price + repair + closing;
  const recCash      = allInCash > 0 ? Math.min(100, Math.round((refiLoan / allInCash) * 100)) : 0;
  const brInFin      = price * 0.25 + repair + closing + hmInterest;
  const backFin      = refiLoan - price * 0.75;
  const recFin       = brInFin > 0 ? Math.min(100, Math.round((backFin / brInFin) * 100)) : 0;
  const brCash = repair >= 10000 && recCash >= 70 && brrrrCF >= 100;
  const brFin  = repair >= 10000 && recFin  >= 70 && brrrrCF >= 100;

  // A strategy qualifies if EITHER purchase method clears its gate. The
  // stamped method is the passing one with the better return, so the card
  // proposes not just what to do with the property but how to buy it.
  const tags = [], methods = {};
  if (bhFin || bhCash) {
    tags.push("buyhold");
    methods.buyhold = (bhFin && bhCash) ? (finCoC >= cashCoC ? "finance" : "cash")
      : bhFin ? "finance" : "cash";
  }
  if (flCash || flFin) {
    tags.push("flip");
    methods.flip = (flCash && flFin) ? (flipROIFin >= flipROI ? "finance" : "cash")
      : flFin ? "finance" : "cash";
  }
  if (brCash || brFin) {
    tags.push("brrrr");
    methods.brrrr = (brCash && brFin) ? (recFin >= recCash ? "finance" : "cash")
      : brFin ? "finance" : "cash";
  }

  const bhBestCF     = methods.buyhold === "cash" ? cashCF : finCF;
  const buyHoldScore = (bhBestCF >= 200 ? 30 : 0) + Math.min(cap, 15) * 2;
  const bestFlipROI  = methods.flip === "finance" ? flipROIFin : flipROI;
  const flipScore    = (bestFlipROI >= 18 ? 30 : 0) + Math.min(bestFlipROI, 50);
  return {tags, buyHoldScore, flipScore, finCF, methods};
  };

  // Ask first; if nothing passes, solve for the highest price that works.
  let offerPrice = ask;
  let res = at(ask);
  if (!res.tags.length && ask > 0) {
    const floor = Math.round(ask * OFFER_FLOOR_PCT / 100);
    if (at(floor).tags.length) {
      let lo = floor, hi = ask;
      for (let i = 0; i < 12; i++) {
        const mid = Math.round((lo + hi) / 2);
        if (at(mid).tags.length) lo = mid; else hi = mid;
      }
      offerPrice = Math.floor(lo / 500) * 500;
      res = at(offerPrice);
      if (!res.tags.length) { offerPrice = lo; res = at(lo); }
    }
  }
  return {...res, offerPrice};
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
// -- Source: IL (convertfleetdotonline/investorlift-property-scraper) ----------
// SHADOW MODE: this actor claims to expose full addresses for InvestorLift
// deals. Until a sample of its addresses is verified against listing photos
// and county records, the pull reports schema and counts in debug but ships
// ZERO items to the feed — a wrong address in front of users is worse than
// a hidden one.
async function pullFromIL(token) {
  if (!token) return {items: [], debug: {error: "APIFY_API_KEY not set"}, ok: false};
  const {parsed, status, debug} = await apifyRunCollect(
    token, "convertfleetdotonline~investorlift-property-scraper", {
      mode:          "active",
      propertyUrls:  [],
      propertyTypes: [],
      states:        [],
    }, {memory: 1024, timeoutS: LONG_RUN_TIMEOUT_S, waitMs: LONG_RUN_WAIT_MS});
  if (!parsed) return {items: [], debug: {...debug, shadow: true}, ok: false};
  const sample = parsed.slice(0, IL_MAX);
  const first  = sample[0];
  return {
    items: [], // shadow: nothing ships until addresses verify
    debug: {
      ...debug,
      shadow:       true,
      rawCount:     parsed.length,
      sampleKeys:   first ? Object.keys(first).slice(0, 60) : [],
      sampleValues: first ? sampleValuePeek(first) : null,
    },
    ok: status === "SUCCEEDED" || parsed.length > 0,
  };
}

// Fill missing rents with real RentCast estimates before underwriting.
// Cheapest candidates first (cash flow lives at the low end), 30-day cache
// under /rentCache so a listing only ever costs one lookup, hard budget cap.
async function enrichRents(deals, key) {
  if (!key) return {error: "RENTCAST_API_KEY not set"};
  const need = deals.filter(d => !(d.rent > 0) && d.streetAddress && d.city && d.state
    && d.price >= 30000 && d.price <= 400000);
  need.sort((a, b) => a.price - b.price);
  const cacheRef = admin.database().ref("rentCache");
  const cache = (await cacheRef.get()).val() || {};
  const now = Date.now(), TTL = 30 * 86400000;
  let fresh = 0, cached = 0, filled = 0;
  for (const d of need) {
    const k = hashId(`${d.streetAddress}|${d.city}|${d.state}`.toLowerCase());
    const hit = cache[k];
    if (hit && now - hit.ts < TTL) {
      cached++;
      if (hit.rent > 0) { d.rent = hit.rent; filled++; }
      continue;
    }
    if (fresh >= RENT_LOOKUPS_MAX) continue;
    fresh++;
    try {
      const q = encodeURIComponent(`${d.streetAddress}, ${d.city}, ${d.state} ${d.zip || ""}`.trim());
      const extras = [
        d.beds ? `&bedrooms=${d.beds}` : "",
        d.baths ? `&bathrooms=${d.baths}` : "",
        d.sqft ? `&squareFootage=${d.sqft}` : "",
      ].join("");
      const r = await fetch(`https://api.rentcast.io/v1/avm/rent/long-term?address=${q}${extras}`,
        {headers: {"X-Api-Key": key}});
      const j = r.ok ? await r.json() : null;
      const rent = j && j.rent ? Math.round(j.rent) : 0;
      await cacheRef.child(k).set({rent, ts: now});
      cache[k] = {rent, ts: now};
      if (rent > 0) { d.rent = rent; filled++; }
    } catch { /* skip this listing, keep the run alive */ }
  }
  return {considered: need.length, fresh, cached, filled};
}

async function runPipeline(apifyKey, rentcastKey) {
  const sources = {dealhive2: 0, il: 0};
  const errors  = {dealhive2: false, il: false};
  const debug   = {};
  const raw     = [];

  // FSBO.com drives a real browser and can poll up to ~7 minutes, all
  // inside this function's 540s ceiling.
  if (!apifyKey) {
    errors.dealhive2 = errors.il = true;
    debug.fsbo = debug.il = {error: "APIFY_API_KEY not set"};
  } else {
    const sourceTasks = [
      {
        name:     "dealhive2",
        debugKey: "fsbo",
        label:    "FSBO.com (DealHive 2)",
        run:      () => pullFromFsbo(apifyKey, FSBO_MAX),
      },
      {
        name:     "il",
        debugKey: "il",
        label:    "InvestorLift (IL, shadow)",
        run:      () => pullFromIL(apifyKey),
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
  const residential = raw.filter(isResidential);
  // Real rents before real verdicts — underwriting quality is bounded by
  // input quality, and rent is the load-bearing input.
  debug.rents = await enrichRents(residential, rentcastKey);
  const scored  = residential
    .map(d => {
      const c = classifyDeal(d);
      return {...d, tags: c.tags, buyHoldScore: c.buyHoldScore, flipScore: c.flipScore,
        cfEst: Math.round(c.finCF), methods: c.methods, offerPrice: c.offerPrice};
    })
    // Underwriting is the door: a deal ships only if at least one of the
    // six purchase-method x exit-strategy paths clears its gate. Anything
    // that doesn't pencil never reaches the page.
    .filter(d => d.tags.length > 0);
  const deduped = dedupByAddress(scored);

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

      // Tier-aware backstops. The app meters itself first (free 3/5/5, Pro
      // 250/mo) — these server caps exist so a tampered client still can't
      // spend past the plan's worst case. Admin runs unmetered.
      if (decoded.email !== "harut@ymail.com") {
        const day = new Date().toISOString().slice(0, 10);
        const ref = admin.database().ref(`rcUsage/${decoded.uid}/${day}`);
        const tx  = await ref.transaction(v => (v || 0) + 1);
        if ((tx.snapshot.val() || 0) > RC_DAILY_CAP) { res.status(429).json({error: "cap"}); return; }

        const tier = (await admin.database().ref(`billing/${decoded.uid}/tier`).get()).val();
        const monthCap = tier === "pro" ? 300 : 20;
        const mo   = new Date().toISOString().slice(0, 7);
        const mref = admin.database().ref(`rcUsage/${decoded.uid}/months/${mo}`);
        const mtx  = await mref.transaction(v => (v || 0) + 1);
        if ((mtx.snapshot.val() || 0) > monthCap) { res.status(429).json({error: "cap"}); return; }
      }

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

// Admin-only per-user API spend report: who used how many lookups this
// month, their tier, and the estimated RentCast cost. This is the "keep
// tabs on what a customer costs us" dashboard.
exports.usageReport = onRequest(
  {cors: true, region: "us-central1", timeoutSeconds: 30},
  async (req, res) => {
    try {
      const user = await verifyUser(req);
      if (!user || user.email !== "harut@ymail.com") { res.status(403).json({error: "admin only"}); return; }
      const mo = new Date().toISOString().slice(0, 7);
      const [usageSnap, billingSnap] = await Promise.all([
        admin.database().ref("rcUsage").get(),
        admin.database().ref("billing").get(),
      ]);
      const usage   = usageSnap.val()  || {};
      const billing = billingSnap.val() || {};
      const rows = Object.entries(usage).map(([uid, days]) => {
        const monthNode = days && days.months && days.months[mo];
        const daySum = Object.entries(days || {})
          .filter(([k]) => k.startsWith(mo + "-"))
          .reduce((s, [, v]) => s + (typeof v === "number" ? v : 0), 0);
        const lookups = Math.max(monthNode || 0, daySum);
        return {uid, lookups, tier: (billing[uid] && billing[uid].tier) || "free"};
      }).filter(r => r.lookups > 0).sort((a, b) => b.lookups - a.lookups).slice(0, 50);
      // Attach emails in one batched auth call.
      const ids = rows.map(r => ({uid: r.uid}));
      const emails = {};
      for (let i = 0; i < ids.length; i += 100) {
        const got = await admin.auth().getUsers(ids.slice(i, i + 100)).catch(() => null);
        if (got) got.users.forEach(u => { emails[u.uid] = u.email || u.uid; });
      }
      // Full member roster, newest first — signups visible without ever
      // opening the Firebase console.
      const listed = await admin.auth().listUsers(1000).catch(() => null);
      const users = listed ? listed.users.map(u => ({
        email: u.email || u.uid,
        tier: (billing[u.uid] && billing[u.uid].tier) || "free",
        created: u.metadata.creationTime || null,
        lastSignIn: u.metadata.lastSignInTime || null,
      })).sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0)) : [];
      res.json({
        month: mo,
        costPerLookup: 0.074,
        users,
        rows: rows.map(r => ({
          email: emails[r.uid] || r.uid, tier: r.tier, lookups: r.lookups,
          estCost: Math.round(r.lookups * 7.4) / 100,
        })),
      });
    } catch (e) {
      logger.error("usageReport", {error: e.message});
      res.status(500).json({error: "report failed"});
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

// == Listing Search (Deal Finder) ===============================================
// The search-first Deals experience: members search a city like they would on
// Zillow and every result comes back underwritten. Listings are served through
// this endpoint so the RapidAPI key stays server-side, results cache in RTDB
// and are SHARED across members (a popular city costs one upstream call), and
// searches meter per member. The provider config below is filled in once the
// RapidAPI listing API is chosen; until then the endpoint reports staged.
const RAPIDAPI_KEY = defineSecret("RAPIDAPI_KEY");
// Private-Zillow on RapidAPI. One /search/byaddress call returns up to ~200
// live for-sale listings, and — the make-or-break — each carries inline photos,
// a rent Zestimate, and a value Zestimate, so we can underwrite every result
// without a second per-property call.
const LISTING_PROVIDER = {
  host: "private-zillow.p.rapidapi.com",
  searchPath: "/search/byaddress",
};
// Monthly search quota per tier. Only FRESH upstream calls burn quota — a city
// someone already searched today is served from the shared cache for free — so
// these numbers cap what a member can cost us, not what they can browse.
const SEARCH_LIMITS = {free: 5, pro: 150};
// A searched city stays warm for 12h. Fresh enough for a for-sale board, and it
// means the tenth member to search Cleveland today pays no upstream call.
const LISTING_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const numOr0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Collapse a free-text location into a stable, RTDB-safe cache key so
// "Cleveland, OH " and "cleveland,  oh" share one warm entry.
function listingCacheKey(q, page) {
  const norm = String(q || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return `${norm.replace(/\s/g, "_")}__p${page || 1}`;
}

// Map a Zillow property type to DealHive's residential buckets. The client only
// analyzes these four; land/commercial map to "Other" and get filtered out.
function mapZillowType(t) {
  const s = String(t || "").toLowerCase();
  if (s.includes("multi")) return "Multi-Family";
  if (s.includes("town")) return "Townhouse";
  if (s.includes("condo") || s.includes("apartment") || s.includes("coop") || s.includes("co_op")) return "Condo";
  if (s.includes("single") || s.includes("manufactured") || s.includes("mobile")) return "Single Family";
  if (s.includes("lot") || s.includes("land") || s.includes("commercial")) return "Other";
  return "Single Family";
}

// Pull the full-size photo URLs off a Zillow media object, preferring the
// high-resolution set, then medium, then the single cover links.
function pickZillowPhotos(media) {
  media = media || {};
  const out = [];
  const push = (u) => { if (typeof u === "string" && u.startsWith("http") && !out.includes(u)) out.push(u); };
  const all = media.allPropertyPhotos || {};
  (all.highResolution || []).forEach(push);
  if (out.length === 0) (all.medium || []).forEach(push);
  const links = media.propertyPhotoLinks || {};
  push(links.highResolutionLink); push(links.mediumSizeLink);
  return out.slice(0, 12);
}

// Normalize one Zillow searchResults entry into the exact deal shape the
// DealHive feed/analyzer already consume, so the client can classify and render
// it with the same pipeline as every other deal.
function mapZillowListing(entry) {
  const p = entry && entry.property ? entry.property : entry;
  if (!p || typeof p !== "object") return null;
  const addr = p.address || {};
  const loc = p.location || {};
  const est = p.estimates || {};
  const priceObj = (p.price && typeof p.price === "object") ? p.price : {};
  const sub = (p.listing && p.listing.listingSubType) || {};
  const photos = pickZillowPhotos(p.media);
  const zpid = p.zpid || p.zpID || p.id || null;
  const street = addr.streetAddress || p.streetAddress || "";
  const priceVal = numOr0(priceObj.value != null ? priceObj.value : p.price);
  const lot = (() => {
    const l = p.lotSizeWithUnit || {};
    const size = numOr0(l.lotSize);
    if (!size) return 0;
    return String(l.lotSizeUnit || "").toLowerCase().startsWith("acre")
      ? Math.round(size * 43560) : Math.round(size);
  })();
  const hdp = (p.hdpView && p.hdpView.hdpUrl) || p.hdpUrl || "";
  return {
    id: "z" + (zpid || `${loc.latitude}_${loc.longitude}_${priceVal}`),
    zpid: zpid ? String(zpid) : null,
    address: street || `${addr.city || ""}, ${addr.state || ""}`.replace(/^, |, $/g, "").trim(),
    streetAddress: street || null,
    city: addr.city || "",
    state: addr.state || "",
    zip: addr.zipcode || addr.zip || "",
    lat: loc.latitude != null ? loc.latitude : null,
    lng: loc.longitude != null ? loc.longitude : null,
    type: mapZillowType(p.propertyType),
    beds: numOr0(p.bedrooms),
    baths: numOr0(p.bathrooms),
    sqft: numOr0(p.livingArea),
    lotSize: lot,
    yearBuilt: numOr0(p.yearBuilt),
    price: priceVal,
    askingPrice: priceVal,
    rent: numOr0(est.rentZestimate),
    arv: numOr0(est.zestimate),
    repair: 0,
    photo: photos[0] || null,
    photos,
    source: "Zillow",
    sourceUrl: hdp ? (hdp.startsWith("http") ? hdp : "https://www.zillow.com" + hdp) : null,
    broker: (p.propertyDisplayRules && p.propertyDisplayRules.mls && p.propertyDisplayRules.mls.brokerName) || null,
    daysOnMarket: numOr0(p.daysOnZillow),
    fsbo: !!sub.isFSBO,
    sourcedAt: new Date().toISOString().slice(0, 10),
  };
}

// First day of next month (UTC) — when a member's monthly search quota resets.
function nextMonthResetISO() {
  const d = new Date();
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  return new Date(Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1)).toISOString().slice(0, 10);
}

exports.searchListings = onRequest({
  secrets: [RAPIDAPI_KEY],
  cors: true, region: "us-central1", timeoutSeconds: 30,
}, async (req, res) => {
  try {
    if (req.method !== "POST") { res.status(405).json({error: "POST only"}); return; }
    const user = await verifyUser(req);
    if (!user) { res.status(401).json({error: "auth"}); return; }
    const body = req.body || {};

    // Tier + this month's usage. Admin is unlimited; everyone else meters.
    const isAdmin = user.email === "harut@ymail.com";
    const tierVal = (await admin.database().ref(`billing/${user.uid}/tier`).get()).val();
    const tier = (isAdmin || tierVal === "pro") ? "pro" : "free";
    const limit = isAdmin ? Infinity : (SEARCH_LIMITS[tier] || SEARCH_LIMITS.free);
    const mo = new Date().toISOString().slice(0, 7);
    const usageRef = admin.database().ref(`searchUsage/${user.uid}/${mo}`);
    const used = numOr0((await usageRef.get()).val());
    const meter = (u) => ({
      tier,
      limit: limit === Infinity ? null : limit,
      used: u,
      remaining: limit === Infinity ? null : Math.max(0, limit - u),
      resets: nextMonthResetISO(),
    });

    // Meter-only ping: the Deal Finder asks for the quota on mount without
    // spending a search.
    if (body.meterOnly) { res.json({meter: meter(used)}); return; }

    const query = String(body.query || "").trim();
    const page = Math.max(1, Math.min(20, parseInt(body.page, 10) || 1));
    if (query.length < 2) {
      res.status(400).json({error: "query", message: "Enter a city, ZIP, or address."});
      return;
    }

    // Shared cache first — a warm city is free and never touches the meter.
    const cacheRef = admin.database().ref(`listingCache/${listingCacheKey(query, page)}`);
    const cached = (await cacheRef.get()).val();
    if (cached && cached.ts && (Date.now() - cached.ts) < LISTING_CACHE_TTL_MS && Array.isArray(cached.items)) {
      res.json({items: cached.items, count: cached.count || cached.items.length,
        totalPages: cached.totalPages || 1, page, cached: true, meter: meter(used)});
      return;
    }

    const key = RAPIDAPI_KEY.value();
    if (!key || key === "unset" || !LISTING_PROVIDER.host) {
      res.status(503).json({error: "staged",
        message: "Listing search is warming up. Check back shortly."});
      return;
    }

    // A fresh upstream call is the part that costs us, so it's what the monthly
    // quota gates.
    if (limit !== Infinity && used >= limit) {
      res.status(429).json({error: "limit", meter: meter(used), message: tier === "pro"
        ? "You've used all 150 searches this month. They reset on the 1st."
        : "You've used your 5 free searches this month. Upgrade to Pro for 150 a month."});
      return;
    }

    // Call the provider. Primary param is `location` (the common convention);
    // if that hard-errors we retry once with `address` (the endpoint is
    // literally /search/byaddress). A valid-but-empty result is trusted as-is.
    const headers = {"X-RapidAPI-Key": key, "X-RapidAPI-Host": LISTING_PROVIDER.host};
    const base = `https://${LISTING_PROVIDER.host}${LISTING_PROVIDER.searchPath}`;
    const pickArray = (j) => Array.isArray(j?.searchResults) ? j.searchResults
      : Array.isArray(j?.results) ? j.results
      : Array.isArray(j?.props) ? j.props
      : Array.isArray(j?.data?.searchResults) ? j.data.searchResults
      : Array.isArray(j) ? j : null;
    let json = null;
    for (const param of ["location", "address"]) {
      let r;
      try {
        r = await fetch(`${base}?${param}=${encodeURIComponent(query)}&page=${page}`, {headers});
      } catch (e) {
        logger.error("searchListings fetch", {param, error: e.message});
        continue;
      }
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        logger.error("searchListings upstream", {param, status: r.status, body: txt.slice(0, 300)});
        continue;
      }
      const j = await r.json().catch(() => null);
      if (pickArray(j) != null) { json = j; break; }
      logger.warn("searchListings unrecognized body", {param, keys: j ? Object.keys(j).slice(0, 8) : null});
    }
    if (json == null) {
      res.status(502).json({error: "upstream",
        message: "The listing service is temporarily unavailable. Try again in a moment."});
      return;
    }

    const items = (pickArray(json) || [])
      .map(mapZillowListing)
      .filter((x) => x && x.price > 0 && (x.lat != null || x.streetAddress));
    const totalPages = (json.pagesInfo && json.pagesInfo.totalPages) || 1;
    const count = (json.resultsCount && json.resultsCount.totalMatchingCount) || items.length;

    // Cache the mapped set (shared across members) and bill one search.
    await cacheRef.set({ts: Date.now(), items, count, totalPages, query, page});
    let newUsed = used;
    if (!isAdmin) { await usageRef.transaction((v) => numOr0(v) + 1); newUsed = used + 1; }
    res.json({items, count, totalPages, page, cached: false, meter: meter(newUsed)});
  } catch (e) {
    logger.error("searchListings", {error: e.message});
    res.status(500).json({error: "search failed"});
  }
});

// == RealEstateAPI (property data + owner) ======================================
// One licensed vendor for the two per-property jobs we used to split across
// RentCast (specs + value + rent) and Endato (owner name). Property Detail
// returns the whole county/public profile for an address in a single ~$0.10
// record: physical specs, an estimated value, an area rent estimate, tax, and
// the owner of record with their mailing address. The key stays server-side;
// the endpoint reports "staged" until REALESTATEAPI_KEY is connected.
const REALESTATEAPI_KEY = defineSecret("REALESTATEAPI_KEY");
const REAPI_BASE = "https://api.realestateapi.com";
const REAPI_TYPE = {SFR: "Single Family", MFR: "Multi-Family", CONDO: "Condo",
  TOWNHOUSE: "Townhouse", MOBILE: "Single Family", LAND: "Other", OTHER: "Other"};

// Normalize a PropertyDetail `data` object into the fields the analyzer and the
// owner reveal consume. suggestedRent is the area rent estimate; when it's
// missing we fall back to the HUD Fair Market Rent that matches the bed count.
function mapReapiDetail(data) {
  if (!data || typeof data !== "object") return null;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const pi = data.propertyInfo || {};
  const addr = pi.address || {};
  const tax = data.taxInfo || {};
  const demo = data.demographics || {};
  const owner = data.ownerInfo || {};
  const mail = owner.mailAddress || {};
  const beds = num(pi.bedrooms);
  const fmr = [demo.fmrEfficiency, demo.fmrOneBedroom, demo.fmrTwoBedroom,
    demo.fmrThreeBedroom, demo.fmrFourBedroom];
  const rent = num(demo.suggestedRent) || num(fmr[Math.max(0, Math.min(4, beds))]) || 0;
  return {
    // Physical specs (replaces the RentCast property pull)
    beds,
    baths: num(pi.bathrooms),
    sqft: num(pi.livingSquareFeet) || num(pi.buildingSquareFeet),
    lotSize: num(pi.lotSquareFeet) || num((data.lotInfo || {}).lotSquareFeet),
    yearBuilt: num(pi.yearBuilt),
    type: REAPI_TYPE[String(data.propertyType || "").toUpperCase()] || "Single Family",
    lat: num(pi.latitude) || null,
    lng: num(pi.longitude) || null,
    city: addr.city || "", state: addr.state || "", zip: addr.zip || "",
    // Valuations
    value: num(data.estimatedValue) || num(tax.estimatedValue) || num(tax.marketValue),
    rent,
    taxAnnual: num(tax.taxAmount),
    assessedValue: num(tax.assessedValue),
    // Owner of record (replaces the Endato owner-name lookup; the phones still
    // come from a skip trace when the member pays to reveal them)
    owner: {
      name: owner.owner1FullName ||
        [owner.owner1FirstName, owner.owner1LastName].filter(Boolean).join(" ") || null,
      firstName: owner.owner1FirstName || null,
      lastName: owner.owner1LastName || null,
      second: owner.owner2FullName ||
        [owner.owner2FirstName, owner.owner2LastName].filter(Boolean).join(" ") || null,
      company: owner.companyName || null,
      corporate: !!(data.corporateOwned || owner.corporateOwned),
      ownerOccupied: !!(data.ownerOccupied != null ? data.ownerOccupied : owner.ownerOccupied),
      mailing: mail.address || null,
      mailingCity: mail.city || null,
      mailingState: mail.state || null,
      mailingZip: mail.zip || null,
      county: mail.county || addr.county || null,
    },
    county: addr.county || mail.county || null,
    reapiId: data.id != null ? String(data.id) : null,
    // Signals REAPI hands us for free — surfaced for later (equity/motivation)
    estimatedEquity: num(data.estimatedEquity),
    openMortgageBalance: num(data.openMortgageBalance),
    absenteeOwner: !!data.absenteeOwner,
    mlsActive: !!data.mlsActive,
    mlsListingPrice: num(data.mlsListingPrice),
  };
}

// Fetch + normalize one PropertyDetail record. Returns null on any miss so
// callers can fall back to their existing source during the migration.
async function reapiPropertyDetail(key, body, uid) {
  const r = await fetch(REAPI_BASE + "/v2/PropertyDetail", {
    method: "POST",
    headers: {"Content-Type": "application/json", "x-api-key": key, "x-user-id": uid || "dealhive"},
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    logger.error("reapi PropertyDetail", {status: r.status, body: txt.slice(0, 300)});
    return {ok: false, status: r.status};
  }
  const j = await r.json().catch(() => null);
  return {ok: true, property: mapReapiDetail(j && j.data)};
}

exports.reapiProperty = onRequest({
  secrets: [REALESTATEAPI_KEY],
  cors: true, region: "us-central1", timeoutSeconds: 30,
}, async (req, res) => {
  try {
    if (req.method !== "POST") { res.status(405).json({error: "POST only"}); return; }
    const user = await verifyUser(req);
    if (!user) { res.status(401).json({error: "auth"}); return; }
    const key = REALESTATEAPI_KEY.value();
    if (!key || key === "unset") {
      res.status(503).json({error: "staged", message: "RealEstateAPI is not connected yet."});
      return;
    }
    const body = req.body || {};
    // Accept a fully formatted address, or the parts — PropertyDetail takes
    // either. A formatted address is the simplest and most reliable.
    const address = String(body.address || "").trim();
    const payload = address.length >= 5
      ? {address}
      : {house: body.house, street: body.street, city: body.city, state: body.state, zip: body.zip};
    if (!payload.address && !(payload.street && (payload.zip || payload.state))) {
      res.status(400).json({error: "address", message: "Provide a full address."});
      return;
    }
    const out = await reapiPropertyDetail(key, payload, user.uid);
    if (!out.ok) { res.status(502).json({error: "upstream", status: out.status}); return; }
    if (!out.property) { res.json({found: false}); return; }
    res.json({found: true, property: out.property});
  } catch (e) {
    logger.error("reapiProperty", {error: e.message});
    res.status(500).json({error: "lookup failed"});
  }
});

// == Skip tracing (Endato / EnformionGO) ========================================
// Provider-evaluation plumbing for the future "Reveal Owner Phone" add-on.
// Endato's Contact Enrich takes a name + address and returns known phones and
// emails; they bill per successful match. Keys are optional: the deploy
// workflow stores an "unset" placeholder until the real GitHub secrets exist,
// and the endpoint reports "not configured" instead of failing.
const ENDATO_AP_NAME     = defineSecret("ENDATO_AP_NAME");
const ENDATO_AP_PASSWORD = defineSecret("ENDATO_AP_PASSWORD");
const ENDATO_BASE        = "https://devapi.endato.com";

// Entity owners (LLCs, trusts, holding companies) can't be traced through a
// people-search API — count them separately instead of burning searches.
const ENTITY_RX = /\b(llc|l\.l\.c|inc|corp|corporation|trust|estate|properties|investments|holdings|ventures|homes|realty|group|partners|lp|llp)\b/i;

// County names arrive "First [Middle] Last [Suffix]", often with a middle
// initial. The first bake-off proved middles poison the match — every
// two-token name hit, every three-token name missed — so send strictly
// first + last: drop initials and Jr/Sr/roman suffixes, surname = last token.
function splitOwnerName(name) {
  const parts = String(name || "").trim().replace(/\./g, "").split(/\s+/).filter(Boolean);
  while (parts.length > 2 && /^([a-z]|jr|sr|ii|iii|iv)$/i.test(parts[parts.length - 1])) parts.pop();
  return {
    first: parts.length > 1 ? parts[0] : "",
    last:  parts.length > 1 ? parts[parts.length - 1] : (parts[0] || ""),
  };
}

async function endatoEnrich(apName, apPassword, {name, address1, address2, nameOverride}) {
  const nm = nameOverride || splitOwnerName(name);
  const FirstName = nm.first;
  const LastName  = nm.last;
  const t0 = Date.now();
  const r = await fetch(ENDATO_BASE + "/Contact/Enrich", {
    method: "POST",
    headers: {
      "Content-Type":       "application/json",
      "galaxy-ap-name":     apName,
      "galaxy-ap-password": apPassword,
      "galaxy-search-type": "DevAPIContactEnrich",
    },
    body: JSON.stringify({
      FirstName, LastName,
      Address: {addressLine1: address1, addressLine2: address2},
    }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  const person = (json && (json.person ||
    (Array.isArray(json.persons) && json.persons[0]))) || null;
  const phones = (person && Array.isArray(person.phones) ? person.phones : [])
    .map(p => ({
      number:      p.number || p.phoneNumber || null,
      type:        p.type || p.phoneType || null,
      isConnected: p.isConnected === true,
      lastSeen:    p.lastReportedDate || null,
    }))
    .filter(p => p.number);
  return {
    status: r.status,
    ms: Date.now() - t0,
    phones,
    emails: (person && Array.isArray(person.emails) ? person.emails : [])
      .map(e => (typeof e === "string" ? e : e.email || e.emailAddress || null))
      .filter(Boolean),
    matchedName: (person && person.name &&
      [person.name.firstName, person.name.lastName].filter(Boolean).join(" ")) || null,
    error: r.ok ? null : (text || "").slice(0, 300),
    // When a 200 comes back with no phones, the top-level keys tell us whether
    // the response shape differs from what we mapped (same trick as IL shadow).
    rawKeys: json ? Object.keys(json).slice(0, 20) : null,
  };
}

// Endato Property Search V2 — their own county/assessor records, searched by
// address, so the owner name and the phones can come from ONE vendor when the
// bake-off runs with &nameSource=endato. Their docs sit behind a login, so
// the route is discovered once per instance from a candidate list: a wrong
// path 404s with a non-JSON body, the real one answers with property JSON
// (or a readable search-type/permission error).
const ENDATO_PROP_PATHS = [
  // Their live routes are single-segment ("/PersonSearch", "/Contact/Enrich"),
  // so lead with those shapes; the first five guesses all 404'd.
  "/PropertySearchV2", "/PropertyV2Search", "/Property/SearchV2",
  "/PropertySearch", "/Search",
  "/PropertySearch/V2", "/Property/Search/V2", "/PropertyV2/Search",
  "/PropertyV2", "/Property/V2/Search",
];
let endatoPropPath = "/PropertyV2Search"; // confirmed live Jul 2026; candidates stay as fallback

// PropertyV2 owner extraction — the run-2 sample nailed the schema:
// propertyV2Records[0].property.summary.currentOwners[].name.fullName, with
// isCorporationOrBusiness flagging entities better than any keyword regex.
function extractOwnerName(json) {
  const rec = json && Array.isArray(json.propertyV2Records) ? json.propertyV2Records[0] : null;
  const owners = (rec && rec.property && rec.property.summary &&
    Array.isArray(rec.property.summary.currentOwners))
    ? rec.property.summary.currentOwners : [];
  for (const o of owners) {
    const nm = o && o.name;
    const full = nm && (nm.fullName ||
      [nm.firstName, nm.lastName].filter(Boolean).join(" "));
    if (full && String(full).trim()) {
      return {
        name: String(full).trim(),
        isEntity: o.isCorporationOrBusiness === true || !!(nm.companyName),
      };
    }
  }
  return null;
}

async function endatoPropertyOwner(apName, apPassword, {address1, address2}) {
  const body = JSON.stringify({FirstName: "", LastName: "",
    AddressLine1: address1, AddressLine2: address2, Page: 1, ResultsPerPage: 1});
  const tryPaths = endatoPropPath ? [endatoPropPath] : ENDATO_PROP_PATHS;
  const attempts = [];
  for (const path of tryPaths) {
    const r = await fetch(ENDATO_BASE + path, {
      method: "POST",
      headers: {
        "Content-Type":       "application/json",
        "galaxy-ap-name":     apName,
        "galaxy-ap-password": apPassword,
        "galaxy-search-type": "PropertyV2",
      },
      body,
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML/empty body */ }
    if (r.status === 404 && !json) { attempts.push({path, status: 404}); continue; }
    endatoPropPath = path;
    if (!r.ok) return {error: `endato ${r.status}`, body: (text || "").slice(0, 220), path};
    const own = extractOwnerName(json);
    return {
      name: own ? own.name : null,
      isEntity: !!(own && own.isEntity),
      path,
      ...(own ? {} : {rawKeys: json ? Object.keys(json).slice(0, 20) : null,
        sample: (text || "").slice(0, 400)}),
    };
  }
  return {error: "endato property endpoint not found", attempts};
}

// One owner trace: Contact Enrich, then a single first/last-swapped retry on
// a clean miss (counties sometimes store "LAST FIRST M" with no comma).
// Shared by the bake-off harness and the production reveal endpoint.
async function traceOwnerPhones(apName, apPass, {name, address1, address2}) {
  let out = await endatoEnrich(apName, apPass, {name, address1, address2});
  let swapRetried = false;
  if (!out.error && !out.phones.length) {
    const nm = splitOwnerName(name);
    if (nm.first && nm.last && nm.first.toLowerCase() !== nm.last.toLowerCase()) {
      try {
        const retry = await endatoEnrich(apName, apPass, {name,
          nameOverride: {first: nm.last, last: nm.first}, address1, address2});
        if (!retry.error && retry.phones.length) { out = retry; swapRetried = true; }
      } catch { /* keep the original miss */ }
    }
  }
  return {...out, swapRetried};
}

// County-record owner name for an address via RentCast /properties — the
// same record Owner Lookup shows members. Returns {name, ownerOccupied} or
// null. County names sometimes arrive "LAST, FIRST M" — reorder on comma.
async function rcOwnerName(rcKey, street, city, state, zip) {
  const q = encodeURIComponent(`${street}, ${city}, ${state}${zip ? " " + zip : ""}`);
  const r = await fetch(`https://api.rentcast.io/v1/properties?address=${q}`, {
    headers: {"X-Api-Key": rcKey},
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    // The body says WHY (invalid key / expired subscription / plan limit /
    // an HTML block page) — surface it instead of a bare status code.
    const errBody = await r.text().catch(() => "");
    return {error: `rc ${r.status}`, body: (errBody || "").slice(0, 220)};
  }
  const body = await r.json().catch(() => null);
  const rec = Array.isArray(body) ? body[0] : body;
  const names = (rec && rec.owner && Array.isArray(rec.owner.names) ? rec.owner.names : []).filter(Boolean);
  if (!names.length) return null;
  let name = String(names[0]).trim();
  if (name.includes(",")) {
    const [last, first] = name.split(",").map(s => s.trim());
    if (first) name = `${first} ${last}`;
  }
  // The owner's MAILING address (where the tax bill goes) is where an absentee
  // owner actually lives — a far better skip-trace anchor than the subject
  // property, which they may not occupy. Owner-occupied? It equals the property.
  const mail = rec.owner && rec.owner.mailingAddress;
  const mailing = (mail && mail.addressLine1) ? {
    line1: mail.addressLine1,
    city:  mail.city  || "",
    state: mail.state || "",
    zip:   mail.zipCode || "",
  } : null;
  const mailingStr = mail
    ? (mail.formattedAddress || [mail.addressLine1, mail.city,
        [mail.state, mail.zipCode].filter(Boolean).join(" ")].filter(Boolean).join(", "))
    : null;
  return {name, ownerOccupied: rec.ownerOccupied === true, mailing,
    mailingStr, county: rec.county || null};
}

// == Reveal Owner Phone (paid add-on) ===========================================
// Pro members buy reveal credits ($10 for 8) and spend 1 per successful trace.
// A credit is charged ONLY when a phone comes back — entity owners, missing
// county records, and dry traces are free and say so. Unlocks persist per
// member under reveals/{uid}/{addrKey} (re-opening is always free), and a
// cross-member cache under skipCache/{addrKey} means a second member's reveal
// of the same address costs us zero provider spend.
// Bump when the trace method changes in a way that should re-run for cached
// and already-unlocked addresses. v2 = anchor on the owner's mailing address.
// v3 = carry owner name, mailing and county into the result so a free-account
// report is self-contained. An already-paid address refreshes free.
const REVEAL_V = 3;
const addrKeyOf = (street, city, state, zip) =>
  (`${street} ${city} ${state} ${zip || ""}`.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 200)) || "x";
const isMobileType = t => /mobile|wireless|cell/i.test(t || "");
const sortPhones = phones => [...phones].sort((a, b) =>
  ((b.isConnected ? 1 : 0) - (a.isConnected ? 1 : 0)) ||
  ((isMobileType(b.type) ? 1 : 0) - (isMobileType(a.type) ? 1 : 0)) ||
  ((Date.parse(b.lastSeen) || 0) - (Date.parse(a.lastSeen) || 0)));

exports.revealOwner = onRequest({
  secrets: [RENTCAST_API_KEY, ENDATO_AP_NAME, ENDATO_AP_PASSWORD],
  cors: true, region: "us-central1", timeoutSeconds: 60,
}, async (req, res) => {
  try {
    if (req.method !== "POST") { res.status(405).json({error: "POST only"}); return; }
    const user = await verifyUser(req);
    if (!user) { res.status(401).json({error: "auth"}); return; }
    const isAdmin = user.email === "harut@ymail.com";
    // Reveal is open to any signed-in member: free accounts buy a single $4.99
    // report, Pro buys cheaper credit packs. The credit balance governs access
    // from here, so there's no tier gate. isFree only controls how much county
    // data we return on a non-charged (miss/entity) result.
    const tier = (await admin.database().ref(`billing/${user.uid}/tier`).get()).val();
    const isFree = !isAdmin && tier !== "pro";

    const balRef = admin.database().ref(`credits/${user.uid}/balance`);
    const balance = (await balRef.get()).val() || 0;
    const b = req.body || {};
    // The admin flag rides every response so the client can offer the reveal
    // without a balance — the owner's own account runs unmetered.
    const flags = isAdmin ? {admin: true} : {};
    if (b.balanceOnly) { res.json({balance, ...flags}); return; }

    const street = String(b.street || "").trim();
    const city   = String(b.city || "").trim();
    const state  = String(b.state || "").trim();
    const zip    = String(b.zip || "").trim();
    if (!street || !city || !state) { res.status(400).json({error: "address"}); return; }
    const k = addrKeyOf(street, city, state, zip);

    // Already unlocked by this member. A current-version unlock re-opens free;
    // an older-version unlock shows its data with a free refresh offer — the
    // member already paid for this address, so a refresh never re-charges.
    const revRef = admin.database().ref(`reveals/${user.uid}/${k}`);
    const mine = (await revRef.get()).val();
    const alreadyPaid = !!mine;
    if (mine && mine.v === REVEAL_V) { res.json({revealed: mine, balance, ...flags}); return; }
    if (!b.confirm) {
      res.json({revealed: mine ? {...mine, stale: true} : null, balance, ...flags});
      return;
    }
    // Daily attempt cap. Hits charge a credit, but misses are free for the
    // member while still costing us a county lookup (and sometimes a trace)
    // — without this, a scripted client could grind unlimited provider spend
    // through garbage addresses. 60/day is ~8x a heavy legitimate day.
    if (!isAdmin) {
      const day  = new Date().toISOString().slice(0, 10);
      const aTx  = await admin.database().ref(`revealUsage/${user.uid}/${day}`)
        .transaction(v => (v || 0) + 1);
      if ((aTx.snapshot.val() || 0) > 60) {
        res.status(429).json({error: "cap", balance});
        return;
      }
    }
    if (!isAdmin && !alreadyPaid && balance < 1) { res.status(402).json({error: "credits", balance}); return; }

    const apName = ENDATO_AP_NAME.value();
    const apPass = ENDATO_AP_PASSWORD.value();
    if (!apName || apName === "unset" || !apPass || apPass === "unset") {
      res.status(503).json({error: "unavailable"}); return;
    }

    // Hits serve from cache for 90 days, misses for 7 (county data moves).
    const cacheRef = admin.database().ref(`skipCache/${k}`);
    const cached = (await cacheRef.get()).val();
    const ageDays = cached ? (Date.now() - (cached.at || 0)) / 86400000 : Infinity;
    let result = null;
    if (cached && cached.v === REVEAL_V && ageDays < (cached.found ? 90 : 7)) {
      result = cached;
    } else {
      const address2 = `${city}, ${state}${zip ? " " + zip : ""}`;
      let rec = null;
      try { rec = await rcOwnerName(RENTCAST_API_KEY.value(), street, city, state, zip); }
      catch { rec = null; }
      if (!rec || rec.error || !rec.name) {
        result = {found: false, v: REVEAL_V, reason: "no-record", at: Date.now()};
      } else if (ENTITY_RX.test(rec.name)) {
        result = {found: false, v: REVEAL_V, reason: "entity", ownerName: rec.name, at: Date.now()};
      } else {
        // Anchor where the owner LIVES — their county mailing (tax-bill)
        // address — not the subject property, which an absentee owner doesn't
        // occupy. That mismatch was pulling in tenants/prior-resident/wrong
        // -person matches. Owner-occupied properties are unaffected (equal).
        const m = rec.mailing;
        const useMailing = !!(m && m.line1);
        const tAddr1 = useMailing ? m.line1 : street;
        const tAddr2 = useMailing
          ? `${m.city}, ${m.state}${m.zip ? " " + m.zip : ""}`.trim()
          : address2;
        const out = await traceOwnerPhones(apName, apPass,
          {name: rec.name, address1: tAddr1, address2: tAddr2});
        result = out.phones.length ? {
          found: true,
          v: REVEAL_V,
          ownerName: rec.name,
          matchedName: out.matchedName || null,
          ownerOccupied: rec.ownerOccupied === true,
          mailingStr: rec.mailingStr || null,
          county: rec.county || null,
          usedMailing: useMailing,
          phones: sortPhones(out.phones).slice(0, 5),
          emails: (out.emails || []).slice(0, 3),
          at: Date.now(),
        } : {found: false, v: REVEAL_V, reason: "no-phone", ownerName: rec.name, at: Date.now()};
      }
      await cacheRef.set(result);
    }

    if (!result.found) {
      // Free accounts don't get owner name/mailing on a non-charged result —
      // otherwise a single $4.99 credit could harvest county data on every
      // entity/no-phone address without ever being spent.
      const safe = isFree
        ? {found: false, v: REVEAL_V, reason: result.reason, at: result.at}
        : result;
      res.json({revealed: safe, balance, ...flags});
      return;
    }

    // Exactly one credit, atomically, only for a hit. Admin runs unmetered.
    // A free refresh of an address the member already paid for skips the charge.
    if (!isAdmin && !alreadyPaid) {
      // RTDB runs the update fn first against the (empty) local cache — v is
      // null on that pass in a cold function. Returning undefined there would
      // ABORT before ever seeing the real balance (the bug that flipped a
      // funded member to "buy credits"). Propose 0 on null so RTDB re-runs
      // against the true server value; only a genuine <1 balance aborts.
      const tx = await balRef.transaction(v => {
        if (v === null) return 0;
        if (v < 1) return; // truly out of credits → abort, no charge
        return v - 1;
      });
      if (!tx.committed) {
        res.status(402).json({error: "credits", balance: (await balRef.get()).val() || 0});
        return;
      }
      await admin.database().ref(`creditsLedger/${user.uid}`).push(
        {delta: -1, reason: "reveal", addr: k, at: Date.now()});
    }
    await revRef.set(result);
    const newBal = (await balRef.get()).val() || 0;
    res.json({revealed: result, balance: newBal, ...flags});
  } catch (e) {
    logger.error("revealOwner", {error: e.message});
    res.status(500).json({error: "unavailable"});
  }
});

// Admin bake-off: trace the live feed's owners through Endato and report the
// hit rate BEFORE any customer-facing reveal button gets built. The FSBO feed
// ships no listing seller names, so owner names come from county records
// (RentCast) first, exactly like the real feature would. Read-only (writes
// nothing, shows nothing to members), same passcode as /pullDealsNow:
//   https://us-central1-darallc.cloudfunctions.net/skipTraceTest?secret=XXXX&n=15
// n is capped at 25 so a test run stays well inside the 100-search trial;
// each traced deal also spends one RentCast property-record call.
exports.skipTraceTest = onRequest({
  timeoutSeconds: 300,
  secrets: [MANUAL_TRIGGER_SECRET, ENDATO_AP_NAME, ENDATO_AP_PASSWORD, RENTCAST_API_KEY],
}, async (req, res) => {
  const expected = MANUAL_TRIGGER_SECRET.value();
  if (!expected || req.query.secret !== expected) {
    res.status(403).send("Forbidden");
    return;
  }
  const apName = ENDATO_AP_NAME.value();
  const apPass = ENDATO_AP_PASSWORD.value();
  if (!apName || apName === "unset" || !apPass || apPass === "unset") {
    res.status(503).json({error: "Endato keys not configured. Add ENDATO_AP_NAME and " +
      "ENDATO_AP_PASSWORD as GitHub Actions secrets, then re-run the Deploy Firebase workflow."});
    return;
  }
  try {
    const n = Math.min(Math.max(parseInt(req.query.n || "10", 10) || 10, 1), 25);
    // &nameSource=endato swaps the owner-name step to Endato Property Search
    // V2 so the whole trace runs on one vendor; default stays RentCast.
    const nameMode = req.query.nameSource === "endato" ? "endato" : "rentcast";
    const rcKey = RENTCAST_API_KEY.value();
    const snap = await admin.database().ref("/deals/items").get();
    const all = Object.values(snap.val() || {});
    const addressComplete = all.filter(d => d.streetAddress && d.city && d.state);
    const withListingName = addressComplete.filter(d => d.seller && d.seller.name);
    const entityOwners = [];
    const noOwnerFound = [];
    const results = [];
    let rcCalls = 0;
    let propCalls = 0;
    let propFirstMiss = null;
    let rcFirstError = null;
    let rcErrorStreak = 0;
    let rcBailedEarly = false;
    let lookupBudget = n * 4; // hard stop — a mapping bug must never walk all 96 again
    for (const d of addressComplete) {
      if (results.length >= n) break;
      if (--lookupBudget < 0) { rcBailedEarly = true; break; }
      // Five county lookups failing in a row means the key/account is the
      // problem, not the addresses — stop burning calls and report.
      if (rcErrorStreak >= 5) { rcBailedEarly = true; break; }
      const address2 = `${d.city}, ${d.state}${d.zip ? " " + d.zip : ""}`;
      const full = `${d.streetAddress}, ${address2}`;

      // Owner name: the listing's seller name when the source shipped one,
      // else the county record — the path every deal supports.
      let name = (d.seller && d.seller.name) || null;
      let nameSource = name ? "listing" : (nameMode === "endato" ? "endato-property" : "county");
      let ownerOccupied = null;
      if (!name) {
        let rec = null;
        if (nameMode === "endato") {
          try { propCalls++; rec = await endatoPropertyOwner(apName, apPass, {address1: d.streetAddress, address2}); }
          catch (e) { rec = {error: String(e.message || e).slice(0, 120)}; }
        } else {
          try { rcCalls++; rec = await rcOwnerName(rcKey, d.streetAddress, d.city, d.state, d.zip); }
          catch (e) { rec = {error: String(e.message || e).slice(0, 120)}; }
        }
        if (rec && rec.error) {
          rcErrorStreak++;
          if (!rcFirstError) rcFirstError = {why: rec.error, body: rec.body || null,
            ...(rec.attempts ? {attempts: rec.attempts} : {})};
          noOwnerFound.push({address: full, why: rec.error});
          continue;
        }
        rcErrorStreak = 0;
        if (!rec || !rec.name) {
          if (nameMode === "endato" && !propFirstMiss) {
            propFirstMiss = {address: full, rawKeys: rec && rec.rawKeys || null,
              sample: rec && rec.sample || null};
          }
          noOwnerFound.push({address: full, why: "no owner on record"});
          continue;
        }
        name = rec.name;
        if (rec.ownerOccupied != null) ownerOccupied = rec.ownerOccupied;
        if (rec.isEntity) { entityOwners.push({name, address: full}); continue; }
      }
      if (ENTITY_RX.test(name)) { entityOwners.push({name, address: full}); continue; }

      let out;
      try {
        out = await traceOwnerPhones(apName, apPass,
          {name, address1: d.streetAddress, address2});
      } catch (e) {
        out = {status: 0, ms: 0, phones: [], emails: [], swapRetried: false,
          error: String(e.message || e).slice(0, 200)};
      }
      results.push({
        address: full,
        owner:   name,
        nameSource,
        ...(out.swapRetried ? {swapRetried: true} : {}),
        ...(ownerOccupied != null ? {ownerOccupied} : {}),
        hit:     out.phones.length > 0,
        phones:  out.phones,
        emails:  (out.emails || []).slice(0, 3),
        matchedName: out.matchedName || null,
        status:  out.status,
        ms:      out.ms,
        ...(out.error ? {error: out.error} : {}),
        ...(out.rawKeys && !out.phones.length ? {rawKeys: out.rawKeys} : {}),
      });
    }
    const hits = results.filter(r => r.hit);
    res.json({
      provider:           "endato",
      diag: {
        nameMode,
        dealsInFeed:          all.length,
        addressComplete:      addressComplete.length,
        withListingSellerName: withListingName.length,
        countyRecordLookups:  rcCalls,
        ...(nameMode === "endato" ? {
          endatoPropertyCalls: propCalls,
          propPathUsed:        endatoPropPath,
          ...(propFirstMiss ? {propFirstMiss} : {}),
        } : {}),
        ownerNotFound:        noOwnerFound.length,
        entityOwners:         entityOwners.length,
        ...(rcBailedEarly ? {rcBailedEarly: true} : {}),
        ...(rcFirstError ? {rcFirstError} : {}),
      },
      attempted:          results.length,
      hits:               hits.length,
      hitRate:            results.length ? Math.round((hits.length / results.length) * 100) + "%" : "n/a",
      withConnectedPhone: results.filter(r => r.phones.some(p => p.isConnected)).length,
      withMobile:         results.filter(r => r.phones.some(p => /mobile|wireless|cell/i.test(p.type || ""))).length,
      results,
      entityOwnersSample: entityOwners.slice(0, 5),
      ownerNotFoundSample: noOwnerFound.slice(0, 5),
    });
  } catch (e) {
    logger.error("skipTraceTest", {error: e.message});
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
const STRIPE_PRICE_ID        = "price_1TgDZo02g0ecGMpyP7iKQCpP"; // DealHive Pro, $29.99/mo
const STRIPE_PRICE_ID_YEARLY = "price_1TvNbs02g0ecGMpywa0rsL36"; // DealHive Pro, $240/yr
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

      const plan = (req.body && req.body.plan) || "monthly";
      let session;
      if (plan === "credits10" || plan === "reveal1") {
        // One-time Reveal credit purchase. Amounts are pinned here — the client
        // only ever names the plan, never a price. The 10-pack ($1/credit) is a
        // Pro perk; free accounts buy a single report at $4.99.
        const isProBuyer = user.email === "harut@ymail.com" ||
          (await billingRef(user.uid).child("tier").get()).val() === "pro";
        const pack = (plan === "credits10" && isProBuyer)
          ? {name: "DealHive Reveal Credits (10 pack)", amount: "1000", credits: "10"}
          : {name: "DealHive Owner Contact Report", amount: "499", credits: "1"};
        session = await stripeReq(key, "POST", "/v1/checkout/sessions", {
          "mode": "payment",
          "customer": customerId,
          "line_items[0][price_data][currency]": "usd",
          "line_items[0][price_data][product_data][name]": pack.name,
          "line_items[0][price_data][unit_amount]": pack.amount,
          "line_items[0][quantity]": "1",
          "client_reference_id": user.uid,
          "metadata[firebaseUid]": user.uid,
          "metadata[credits]": pack.credits,
          "allow_promotion_codes": "true",
          "success_url": `${APP_ORIGIN}/?billing=credits&session_id={CHECKOUT_SESSION_ID}`,
          "cancel_url": `${APP_ORIGIN}/?billing=cancelled`,
        });
      } else {
        session = await stripeReq(key, "POST", "/v1/checkout/sessions", {
          "mode": "subscription",
          "customer": customerId,
          "line_items[0][price]": plan === "yearly" ? STRIPE_PRICE_ID_YEARLY : STRIPE_PRICE_ID,
          "line_items[0][quantity]": "1",
          "client_reference_id": user.uid,
          "subscription_data[metadata][firebaseUid]": user.uid,
          "allow_promotion_codes": "true",
          "success_url": `${APP_ORIGIN}/?billing=success`,
          "cancel_url": `${APP_ORIGIN}/?billing=cancelled`,
        });
      }
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

// Idempotent credit grant for a paid checkout session — used by both the
// return-URL claim (below) and the webhook, so credits land even if one path
// never fires. The creditSessions/{id} marker makes double-grants impossible.
async function applyCreditPurchase(session) {
  const uid = (session && (session.client_reference_id ||
    (session.metadata && session.metadata.firebaseUid))) || null;
  const credits = parseInt(session && session.metadata && session.metadata.credits, 10) || 0;
  // A 100%-off promotion code completes with "no_payment_required" instead
  // of "paid" — both mean the session is settled and owed its credits.
  const settled = session && (session.payment_status === "paid" ||
    session.payment_status === "no_payment_required");
  if (!uid || !credits || !settled) return null;
  const marker = admin.database().ref(`creditSessions/${session.id}`);
  const tx = await marker.transaction(v => (v === null ? {uid, credits, at: Date.now()} : undefined));
  if (tx.committed) {
    await admin.database().ref(`credits/${uid}/balance`).transaction(v => (v || 0) + credits);
    await admin.database().ref(`creditsLedger/${uid}`).push(
      {delta: credits, reason: "purchase", sessionId: session.id, at: Date.now()});
  }
  return (await admin.database().ref(`credits/${uid}/balance`).get()).val() || 0;
}

// Webhook-independent credit activation — same lesson as Pro: the client
// comes back from Stripe holding the session id and claims it directly.
exports.claimCredits = onRequest(
  {secrets: [STRIPE_SECRET_KEY], cors: true, region: "us-central1", timeoutSeconds: 30},
  async (req, res) => {
    try {
      if (req.method !== "POST") { res.status(405).json({error: "POST only"}); return; }
      const user = await verifyUser(req);
      if (!user) { res.status(401).json({error: "Sign in first."}); return; }
      const sid = req.body && req.body.sessionId;
      if (!sid || !/^cs_[A-Za-z0-9_]+$/.test(String(sid))) { res.status(400).json({error: "bad session"}); return; }
      const session = await stripeReq(STRIPE_SECRET_KEY.value(), "GET", `/v1/checkout/sessions/${sid}`);
      const uid = session.client_reference_id || (session.metadata && session.metadata.firebaseUid);
      if (uid !== user.uid) { res.status(403).json({error: "not yours"}); return; }
      const balance = await applyCreditPurchase(session);
      if (balance === null) { res.status(400).json({error: "not paid yet"}); return; }
      res.json({balance});
    } catch (e) {
      logger.error("claimCredits", {error: e.message});
      res.status(500).json({error: "claim failed"});
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
      } else if (event.type === "checkout.session.completed" && obj.mode === "payment") {
        const balance = await applyCreditPurchase(obj);
        if (balance != null) logger.info("stripe: reveal credits applied", {balance});
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
