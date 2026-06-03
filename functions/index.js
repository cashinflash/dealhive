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

// Pull caps tuned for "Abundant ~300 deals/day across three sources":
//   InvestorLift (Apify):  50 raw / day
//   DealHive2  (seibs.co):  25 / location × 7 locations = 175 raw / day
//   DealHive 3 (propwire):  100 raw / day
// Both override-able via env vars for live tuning without redeploy.
const INVESTORLIFT_MAX  = parseInt(process.env.INVESTORLIFT_MAX  || "50",  10);
const MOVOTO_PER_LOCATION = parseInt(process.env.MOVOTO_PER_LOCATION || "25", 10);
const PROPWIRE_MAX      = parseInt(process.env.PROPWIRE_MAX      || "100", 10);

// Locations the seibs.co actor scans (it requires explicit "City, State" strings).
const DEAL_LOCATIONS = (process.env.DEAL_LOCATIONS || [
  "Cleveland, OH",
  "Detroit, MI",
  "Memphis, TN",
  "Birmingham, AL",
  "Indianapolis, IN",
  "Kansas City, MO",
  "Austin, TX",
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

// -- Source: DealHive 2 (jupri/movoto via Apify) ------------------------------
// Movoto-style site scrapers typically accept either a list of search URLs or
// city/state strings. We send `locations` as our best guess; the debug payload
// (sampleKeys + sampleValues + httpStatus body) on the first run will tell us
// if we need a different input shape.
async function pullFromMovoto(token, locations, maxPerLocation) {
  if (!token) return {items: [], debug: {error: "APIFY_API_KEY not set"}, ok: false};
  const actor = "jupri~movoto";
  const url   = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${token}&memory=1024`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        locations,
        maxItems:                 locations.length * maxPerLocation,
        max_results_per_location: maxPerLocation,
      }),
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
  const sampleKeys   = parsed[0] ? Object.keys(parsed[0]).slice(0, 50) : [];
  const sampleValues = parsed[0] ? sampleValuePeek(parsed[0]) : null;
  const items = parsed.map(mapMovotoDeal).filter(Boolean);
  return {
    items,
    debug: {
      httpStatus:   res.status,
      rawCount:     parsed.length,
      mappedCount:  items.length,
      droppedCount: parsed.length - items.length,
      sampleKeys, sampleValues,
    },
    ok: true,
  };
}

function mapMovotoDeal(raw) {
  // Movoto scrapers typically expose MLS listing fields (list_price, address,
  // beds, baths, sqft, photos). We try common shapes; once we see the first
  // real response we can lock the mapper to the actual field names.
  const price = parseLoose(raw.price || raw.list_price || raw.listPrice || raw.askingPrice);
  const city  = raw.city || "";
  const state = normalizeState(raw.state || raw.state_code || raw.state_abbreviation);
  if (!price || !city) return null;

  const photos = pickPhotos(raw);
  const beds   = int(raw.bedrooms || raw.beds);
  const type   = normalizeType(raw.property_type || raw.propertyType || raw.type);
  const streetAddress = raw.address || raw.street_address || raw.formatted_address || null;

  return {
    id:        "m2-" + (raw.id || raw.mls_id || raw.mlsId || raw.listing_id || hashId(`${streetAddress || ""}|${city}|${state}`)),
    source:    "DealHive 2", // jupri/movoto via Apify
    sourceUrl: null, // never link out
    sourcedAt: today(),
    address:       generateDealTitle({beds, type, city, state}),
    streetAddress,
    city,
    state,
    zip:       String(raw.zip || raw.zipcode || raw.zip_code || raw.postal_code || ""),
    lat:       num(raw.latitude  || raw.lat),
    lng:       num(raw.longitude || raw.lng || raw.lon),
    type,
    beds,
    baths:     num(raw.bathrooms || raw.baths),
    sqft:      int(raw.sqft || raw.square_footage || raw.livingArea || raw.living_area),
    yearBuilt: int(raw.year_built || raw.yearBuilt),
    price,
    repair:    0, // movoto listings are retail; classifyDeal applies the 15%-of-ARV default
    rent:      int(raw.rent_estimate || raw.estimated_rent),
    arv:       int(raw.arv || raw.arv_estimate || raw.estimated_value || raw.zestimate),
    photo:     photos[0] || null,
    photos,
    seller: {
      // Movoto listings sometimes carry the listing agent. Surface that for
      // Pro members if it's there; phone/email rarely come through on these
      // scrapers though.
      name:    raw.agent_name || raw.listing_agent || raw.agentName || null,
      company: raw.brokerage   || raw.broker_name  || raw.brokerName || null,
      phone:   raw.agent_phone || raw.agentPhone   || null,
      email:   raw.agent_email || raw.agentEmail   || null,
    },
    market:      marketIdForState(state),
    description: raw.description ? String(raw.description).slice(0, 500) : null,
  };
}

// -- Source: DealHive 3 (crawlerbros/propwire-leads-scraper via Apify) --------
async function pullFromPropwire(token, locations, maxItems) {
  if (!token) return {items: [], debug: {error: "APIFY_API_KEY not set"}, ok: false};
  const actor = "crawlerbros~propwire-leads-scraper";
  const url   = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${token}&memory=1024`;
  let res;
  try {
    // Best-guess input — adjust once we see the actor's schema on first run.
    res = await fetch(url, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({locations, maxItems}),
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
  const sampleKeys   = parsed[0] ? Object.keys(parsed[0]).slice(0, 50) : [];
  const sampleValues = parsed[0] ? sampleValuePeek(parsed[0]) : null;
  const items = parsed.map(mapPropwireDeal).filter(Boolean);
  return {
    items,
    debug: {
      httpStatus:   res.status,
      rawCount:     parsed.length,
      mappedCount:  items.length,
      droppedCount: parsed.length - items.length,
      sampleKeys, sampleValues,
    },
    ok: true,
  };
}

function mapPropwireDeal(raw) {
  // propwire surfaces both MLS-listed and pure off-market leads. For the deal
  // feed we need a price to compute spreads, so we prefer the MLS list price,
  // fall back to the estimated value when the property isn't actively listed.
  const price = parseLoose(raw.mlsListPrice || raw.estimatedValue || raw.price);
  const city  = raw.city || "";
  const state = normalizeState(raw.state || raw.state_code);
  if (!price || !city) return null;

  const photos = pickPhotos(raw);
  const beds   = int(raw.bedrooms);
  const type   = normalizeType(raw.propertyType || raw.property_type);

  // propwire gives us an actual street address — surface it in description
  // for Pro members. Keep `address` as the consistent generated title so all
  // sources render uniformly on the card.
  const ownerBlurb = [
    raw.ownerName     && `Owner: ${raw.ownerName}`,
    raw.yearsOfOwnership && `Owned ${raw.yearsOfOwnership}+ yrs`,
    raw.estimatedEquityPercentage && `${Math.round(raw.estimatedEquityPercentage)}% equity`,
    raw.daysOnMarket  > 0 && `${raw.daysOnMarket} DOM`,
  ].filter(Boolean).join(" · ");
  const desc = [
    raw.address && `${raw.address}, ${city}${state ? `, ${state}` : ""}${raw.zip ? ` ${raw.zip}` : ""}`,
    ownerBlurb,
    raw.description,
  ].filter(Boolean).join("\n\n").slice(0, 800);

  return {
    id:        "s3-" + (raw.id || hashId(`${raw.address || ""}|${city}|${state}`)),
    source:    "DealHive 3", // propwire via Apify (crawlerbros~propwire-leads-scraper)
    sourceUrl: null,
    sourcedAt: today(),
    // `address` is the clean display title; `streetAddress` is the real
    // physical address used to prefill the Deal Analyzer.
    address:       generateDealTitle({beds, type, city, state}),
    streetAddress: raw.address || null,
    city,
    state,
    zip:       String(raw.zip || ""),
    lat:       num(raw.latitude),
    lng:       num(raw.longitude),
    type,
    beds,
    baths:     num(raw.bathrooms),
    sqft:      int(raw.livingAreaSf || raw.buildingAreaSf),
    yearBuilt: int(raw.yearBuilt),
    price,
    repair:    0, // propwire doesn't publish a rehab estimate; classifyDeal defaults
    rent:      0, // 1% rule fallback in classifyDeal handles buyhold scoring
    // estimatedValue is propwire's current-value AVM — used as ARV proxy when
    // available; classifyDeal falls back to price × 1.30 if it's missing.
    arv:       int(raw.estimatedValue),
    photo:     photos[0] || null,
    photos,
    seller: {
      // The "owner" on propwire IS the current homeowner — Pro users can
      // cold-call/direct-mail them. No phone/email exposed by this actor.
      name:    raw.ownerName || null,
      company: null,
      phone:   null,
      email:   null,
    },
    market:      marketIdForState(state),
    description: desc || null,
    daysListed:  int(raw.daysOnMarket),
  };
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

// Strip values to a safe slice (first ~10 fields, truncated strings) for the
// debug payload — enough to debug schema/coercion without leaking large blobs.
function sampleValuePeek(obj) {
  const out = {};
  let n = 0;
  for (const k of Object.keys(obj)) {
    if (n++ >= 12) break;
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
async function runPipeline(apifyKey, _rentcastKey) {
  const sources = {investorlift: 0, dealhive2: 0, dealhive3: 0};
  const errors  = {investorlift: false, dealhive2: false, dealhive3: false};
  const debug   = {};
  const raw     = [];

  // Pulls run in parallel. Each Apify actor takes 1-3 minutes, so sequential
  // would push the total runtime past the timeout safe Safari can hold the
  // /pullDealsNow URL open for. 3 parallel × 1GB memory each = 3GB, well
  // under Apify's 8GB account ceiling.
  if (!apifyKey) {
    errors.investorlift = errors.dealhive2 = errors.dealhive3 = true;
    debug.apify = debug.movoto = debug.propwire = {error: "APIFY_API_KEY not set"};
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
        debugKey: "movoto",
        label:    "Movoto (DealHive 2)",
        run:      () => pullFromMovoto(apifyKey, DEAL_LOCATIONS, MOVOTO_PER_LOCATION),
      },
      {
        name:     "dealhive3",
        debugKey: "propwire",
        label:    "propwire (DealHive 3)",
        run:      () => pullFromPropwire(apifyKey, DEAL_LOCATIONS, PROPWIRE_MAX),
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

  const itemsMap = Object.fromEntries(deduped.map(d => [d.id, d]));
  await admin.database().ref("/deals").set({
    updatedAt: Date.now(),
    count:     deduped.length,
    sources,
    items:     itemsMap,
  });

  logger.info(`✓ Wrote ${deduped.length} deals (raw ${raw.length})`, sources);
  return {written: deduped.length, raw: raw.length, sources, debug, skipped: false};
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
