// DealHive nightly deal-pipeline.
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
const MARKETS = [
  {id:"cle", city:"Cleveland",    state:"OH"},
  {id:"det", city:"Detroit",      state:"MI"},
  {id:"mem", city:"Memphis",      state:"TN"},
  {id:"bhm", city:"Birmingham",   state:"AL"},
  {id:"ind", city:"Indianapolis", state:"IN"},
  {id:"kcm", city:"Kansas City",  state:"MO"},
];

// Residential 1-4 unit only — these strings must match what normalizeType()
// emits below and what isResidential() in the React app accepts.
const RESIDENTIAL_TYPES = new Set([
  "Single Family", "Multi-Family", "Townhouse", "Condo",
]);

// Pull caps tuned for "Conservative ~200 deals/day":
//   InvestorLift: 50 raw / day (after dedup ~30-50)
//   RentCast:     25 / market × 6 markets = 150 raw / day
// Both override-able via env vars for live tuning without redeploy.
const INVESTORLIFT_MAX        = parseInt(process.env.INVESTORLIFT_MAX        || "50", 10);
const RENTCAST_MAX_PER_MARKET = parseInt(process.env.RENTCAST_MAX_PER_MARKET || "25", 10);

// -- Source: Apify InvestorLift scraper ---------------------------------------
async function pullFromApify(token, maxItems) {
  if (!token) return [];
  const actor = "corent1robert~investorlift-scraper";
  // `run-sync-get-dataset-items` blocks until the actor finishes and streams
  // the dataset back — fine for a scheduled job, simpler than polling runs.
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      maxItems,
      enrichWithDetails: true, // pulls photos + contact, more compute units
      dealIds: [],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Apify HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const items = await res.json();
  if (!Array.isArray(items)) {
    logger.warn("Apify returned non-array payload", {keys: Object.keys(items || {})});
    return [];
  }
  return items.map(mapApifyDeal).filter(Boolean);
}

// Apify actors don't have a stable output schema — third-party scrapers can
// shape data however they like, and the maintainer can change it any time.
// We try the obvious field names and bail (return null) when we can't get
// enough to render a card. dedupByAddress + the rest of the pipeline naturally
// drop the nulls.
function mapApifyDeal(raw) {
  const address = raw.address || raw.streetAddress || raw.propertyAddress || raw.fullAddress || "";
  const price   = Number(raw.price || raw.askingPrice || raw.listPrice || raw.askPrice || 0);
  if (!address || !price) return null;

  const photo = pickFirst(raw.photos) || raw.photoUrl || raw.imageUrl || raw.image || null;
  return {
    id:        hashId("il-" + address),
    source:    "DealHive Network", // do NOT surface "InvestorLift" on public cards
    sourceUrl: raw.url || raw.detailUrl || raw.listingUrl || null,
    sourcedAt: today(),
    address,
    city:      raw.city || "",
    state:     normalizeState(raw.state),
    zip:       String(raw.zip || raw.zipCode || raw.postalCode || ""),
    lat:       num(raw.latitude  || raw.lat),
    lng:       num(raw.longitude || raw.lng || raw.lon),
    type:      normalizeType(raw.propertyType || raw.type || raw.category),
    beds:      int(raw.bedrooms || raw.beds),
    baths:     num(raw.bathrooms || raw.baths),
    sqft:      int(raw.squareFootage || raw.sqft || raw.livingArea),
    yearBuilt: int(raw.yearBuilt),
    price,
    repair:    int(raw.estimatedRepairs || raw.rehabBudget || raw.repairs),
    rent:      int(raw.estimatedRent || raw.rentEstimate || raw.rent),
    arv:       int(raw.arv || raw.afterRepairValue || raw.valueEstimate),
    photo,
    seller: {
      name:  raw.sellerName  || raw.contactName  || raw.agentName  || null,
      phone: raw.sellerPhone || raw.contactPhone || raw.agentPhone || null,
      email: raw.sellerEmail || raw.contactEmail || raw.agentEmail || null,
    },
    market: marketIdForState(normalizeState(raw.state)),
  };
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
  // For listings missing a rent estimate (RentCast active-listings feed doesn't
  // include one), fall back to the "1% rule" — monthly rent ~= 1% of price.
  // It's a conservative proxy; users see the real number after running comps
  // in the analyzer. Without this fallback, cap rate divides by zero and every
  // RentCast listing fails the buyhold filter.
  const rent       = deal.rent && deal.rent > 0 ? deal.rent : Math.round((deal.price || 0) * 0.01);
  const monthlyTax = Math.round((deal.price * 0.0233) / 12);
  const PI         = monthlyPI(deal.price * 0.8, 7.5);
  const exp        = monthlyTax + 100 + Math.round(rent * 0.08);
  const effRent    = rent * 0.95;
  const finCF      = effRent - exp - PI;
  const noi        = (effRent - exp) * 12;
  const finCap     = deal.price > 0 ? (noi / deal.price) * 100 : 0;

  const arv        = deal.arv || Math.round(deal.price * 1.35);
  const totalIn    = (deal.price || 0) + (deal.repair || 0);
  const flipProfit = Math.round(arv - totalIn - arv * 0.06 - arv * 0.02 - 6 * 600);
  const flipROI    = totalIn > 0 ? (flipProfit / totalIn) * 100 : 0;

  // Thresholds tuned for cash-flow markets (Cleveland / Detroit / Memphis / etc.)
  // where median wholesale prices sit at $40-100k. Earlier $20k flip-profit gate
  // filtered out the entire feed.
  const tags = [];
  if (finCap >= 6   && finCF      > 0)      tags.push("buyhold");
  if (flipROI >= 12 && flipProfit >= 10000) tags.push("flip");
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
function num(v)  { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; }
function int(v)  { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }
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
  if (v.includes("single"))                                                          return "Single Family";
  if (v.includes("duplex") || v.includes("triplex") || v.includes("fourplex")
      || v.includes("multi") || v.includes("2-4") || v.includes("2 to 4"))           return "Multi-Family";
  if (v.includes("town"))                                                            return "Townhouse";
  if (v.includes("condo"))                                                           return "Condo";
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
async function runPipeline(apifyKey, rentcastKey) {
  const sources = {investorlift: 0, rentcast: 0};
  const raw     = [];

  // 1. Apify InvestorLift — wrap in try/catch so one bad source can't take
  // the whole nightly down.
  if (apifyKey) {
    try {
      const items = await pullFromApify(apifyKey, INVESTORLIFT_MAX);
      sources.investorlift = items.length;
      raw.push(...items);
      logger.info(`Pulled ${items.length} from Apify InvestorLift`);
    } catch (e) {
      logger.error("Apify pull failed", {error: e.message});
    }
  } else {
    logger.warn("APIFY_API_KEY not set — skipping InvestorLift");
  }

  // 2. RentCast per market.
  if (rentcastKey) {
    for (const market of MARKETS) {
      try {
        const items = await pullFromRentCast(rentcastKey, market, RENTCAST_MAX_PER_MARKET);
        sources.rentcast += items.length;
        raw.push(...items);
      } catch (e) {
        logger.error(`RentCast ${market.id} failed`, {error: e.message});
      }
    }
    logger.info(`Pulled ${sources.rentcast} from RentCast across ${MARKETS.length} markets`);
  } else {
    logger.warn("RENTCAST_API_KEY not set — skipping RentCast");
  }

  // 3. Filter to residential + only deals that score on at least one strategy.
  const scored  = raw
    .filter(isResidential)
    .map(d => ({d, tags: classifyDeal(d)}))
    .filter(({tags}) => tags.length > 0);
  const deduped = dedupByAddress(scored.map(({d}) => d));

  // 4. Safety net: if both sources failed (empty `raw`), do NOT clobber the
  // existing /deals — yesterday's data is better than no data.
  if (raw.length === 0) {
    logger.warn("All sources empty — leaving existing /deals untouched.");
    return {written: 0, raw: 0, sources, skipped: true};
  }

  const itemsMap = Object.fromEntries(deduped.map(d => [d.id, d]));
  await admin.database().ref("/deals").set({
    updatedAt: Date.now(),
    count:     deduped.length,
    sources,
    items:     itemsMap,
  });

  logger.info(`✓ Wrote ${deduped.length} deals (raw ${raw.length})`, sources);
  return {written: deduped.length, raw: raw.length, sources, skipped: false};
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
