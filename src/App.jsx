import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import Landing, { MarketingChrome } from "./Landing.jsx";

// -- Error Boundary ------------------------------------------------------------
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError:false, msg:"" }; }
  static getDerivedStateFromError(e) { return { hasError:true, msg:e.message }; }
  render() {
    if (this.state.hasError) return (
      <div style={{padding:40,textAlign:"center",fontFamily:"Inter,sans-serif"}}>
        <div style={{fontSize:36,marginBottom:12}}>[!]</div>
        <div style={{fontSize:16,fontWeight:700,color:"#111827",marginBottom:8}}>Something went wrong</div>
        <div style={{fontSize:13,color:"#6b7280",marginBottom:20,maxWidth:400,margin:"0 auto 20px"}}>{this.state.msg}</div>
        <button onClick={()=>this.setState({hasError:false,msg:""})}
          style={{background:"#10b981",color:"white",border:"none",borderRadius:8,padding:"10px 24px",cursor:"pointer",fontSize:14,fontWeight:600}}>
          Try Again
        </button>
      </div>
    );
    return this.props.children;
  }
}

// -- Config --------------------------------------------------------------------
const FB_API_KEY     = "AIzaSyBHyb_dgcwSMvHYJ3CNfjy0dB2xWTU222U";
const FB_AUTH_URL    = "https://identitytoolkit.googleapis.com/v1";
const FB_DB_URL      = "https://darallc-default-rtdb.firebaseio.com";
const GOOGLE_API_KEY = "AIzaSyAYrJOulIBpfDZIgC50IXSgbXET05VqOC8";
const RC_BASE        = "https://api.rentcast.io/v1";
const FN_BASE        = "https://us-central1-darallc.cloudfunctions.net";
const RC_PROXY       = FN_BASE + "/rcProxy";
// One door to property data: a personal API key (legacy admin path) hits
// RentCast directly; otherwise any signed-in session goes through our server
// proxy, so customers never see or handle keys. `path` is "/endpoint?query".
const rcGet = async (path, auth) => {
  if (auth && auth.key) {
    const r = await fetch(RC_BASE + path, {headers: {"X-Api-Key": auth.key}});
    if (!r.ok) throw new Error("rc " + r.status);
    return r.json();
  }
  if (auth && auth.token) {
    const r = await fetch(`${RC_PROXY}?path=${encodeURIComponent(path)}`,
      {headers: {Authorization: "Bearer " + auth.token}});
    if (!r.ok) throw new Error("rc-proxy " + r.status);
    return r.json();
  }
  throw new Error("rc-noauth");
};
const rcOk = auth => !!(auth && (auth.key || auth.token));
const TRIAL_DAYS     = 7;
const VERSION        = "1.0.0";
const DEFAULT_CLOSING = 10895;
// Ohio effective property-tax rate (~2.33%/yr). Monthly = taxValue * rate / 12.
const OH_TAX_RATE = 0.0233;
// Ohio assessed value is 35% of market value by law; market = assessed / 0.35.
const OH_ASSESS_RATIO = 0.35;
const isOhio = obj => String((obj && obj.state) || "").trim().toUpperCase() === "OH";

// -- API cost controls ---------------------------------------------------------
// Each external property/comp "lookup" can fan out to several billable API
// calls, so two levers keep cost predictable:
//   1. A cache (per user, TTL'd) — repeating the same address is free.
//   2. A monthly cap on fresh (cache-miss) lookups — bounds worst-case spend.
// LOOKUP_CAP is the only knob most people need to tune.
const LOOKUP_CAP    = 200;            // fresh billable lookups per user, per month
const CACHE_TTL_MS  = 30 * 86400000;  // cached results stay fresh for 30 days
const CACHE_MAX     = 50;             // most recent entries kept; older ones pruned
const monthKey      = () => new Date().toISOString().slice(0, 7);   // "2026-05"
const lookupKey     = (...parts) =>
  parts.map(p => String(p == null ? "" : p).toLowerCase().replace(/\s+/g, " ").trim()).join("|");
const LOOKUP_CAP_MSG = `You've used all ${LOOKUP_CAP} property lookups for this month. They reset on the 1st — re-opening addresses you've already looked up is always free.`;

// -- Firebase Auth -------------------------------------------------------------
const fbSignUp = async (email, password) => {
  const r = await fetch(`${FB_AUTH_URL}/accounts:signUp?key=${FB_API_KEY}`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({email, password, returnSecureToken:true})
  });
  const d = await r.json(); if(d.error) throw new Error(d.error.message); return d;
};
const fbSignIn = async (email, password) => {
  const r = await fetch(`${FB_AUTH_URL}/accounts:signInWithPassword?key=${FB_API_KEY}`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({email, password, returnSecureToken:true})
  });
  const d = await r.json(); if(d.error) throw new Error(d.error.message); return d;
};
// Google OAuth Web client ID (Firebase console -> Authentication -> Google ->
// Web SDK configuration). Empty string = Google button shows a friendly
// "finishing setup" note instead of a broken flow.
const GOOGLE_OAUTH_CLIENT_ID = "916047270875-hmhipksaj16hq618uefn00eed7u2c9qm.apps.googleusercontent.com";
const fbSignInWithIdp = async (postBody) => {
  const r = await fetch(`${FB_AUTH_URL}/accounts:signInWithIdp?key=${FB_API_KEY}`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({postBody, requestUri: window.location.origin,
      returnIdpCredential: true, returnSecureToken: true}),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || "IDP_ERROR");
  return d;
};
const fbResetPassword = async (email) => {
  const r = await fetch(`${FB_AUTH_URL}/accounts:sendOobCode?key=${FB_API_KEY}`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({requestType:"PASSWORD_RESET", email})
  });
  const d = await r.json(); if(d.error) throw new Error(d.error.message); return d;
};
// Exchange a refresh token for a fresh ID token. Firebase ID tokens expire
// after ~1 hour; without refreshing, cloud reads/writes start failing and the
// app silently falls back to this-device-only storage (breaks cross-device sync).
const fbRefresh = async (refreshToken) => {
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FB_API_KEY}`, {
    method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:`grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken||"")}`,
  });
  const d = await r.json();
  if (d.error || !d.id_token) throw new Error((d.error && d.error.message) || "Token refresh failed");
  return { idToken: d.id_token, refreshToken: d.refresh_token };
};

// -- Firebase DB ---------------------------------------------------------------
const dbPath   = uid => `${FB_DB_URL}/users/${uid}/data.json`;
const metaPath = uid => `${FB_DB_URL}/users/${uid}/meta.json`;
// billing/{uid} is written only by the Stripe webhook (server-side); the app
// reads it at sign-in and treats it as the tier authority.
const loadBilling = async (uid, token) => {
  try {
    const r = await fetch(`${FB_DB_URL}/billing/${uid}.json?auth=${token}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
};

// -- Firebase Storage (user photo uploads) --------------------------------------
// The default bucket name differs by project age; we try both and remember
// which one answers. Until Storage is enabled in the Firebase console, both
// 404 and the uploader reports a friendly setup message.
const FB_STORAGE_BUCKETS = ["darallc.firebasestorage.app", "darallc.appspot.com"];
let fbBucketPick = 0;
const fbStorageUpload = async (path, blob, token) => {
  for (let attempt = 0; attempt < FB_STORAGE_BUCKETS.length; attempt++) {
    const i = (fbBucketPick + attempt) % FB_STORAGE_BUCKETS.length;
    const bucket = FB_STORAGE_BUCKETS[i];
    let r;
    try {
      r = await fetch(
        `https://firebasestorage.googleapis.com/v0/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(path)}`,
        {method:"POST", headers:{Authorization:`Firebase ${token}`, "Content-Type":"image/jpeg"}, body: blob});
    } catch { continue; } // browser-level rejection (nonexistent bucket blocks CORS) — try the next name
    if (r.status === 404) continue; // bucket doesn't exist under this name
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error && d.error.message) || "Upload failed — try again.");
    fbBucketPick = i;
    const tok = String(d.downloadTokens || "").split(",")[0];
    return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(d.name)}?alt=media${tok ? `&token=${tok}` : ""}`;
  }
  throw new Error("Photo storage isn't switched on yet — it's coming shortly.");
};

// Shrink phone photos before upload: max 1600px on the long edge, JPEG.
const compressImage = (file, maxDim = 1600, quality = 0.82) => new Promise((resolve, reject) => {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(url);
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    cv.getContext("2d").drawImage(img, 0, 0, w, h);
    cv.toBlob(b => b ? resolve(b) : reject(new Error("Couldn't read that image.")), "image/jpeg", quality);
  };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read that image.")); };
  img.src = url;
});

const saveData = async (uid, token, d) => {
  try {
    const r = await fetch(`${dbPath(uid)}?auth=${token}`, {
      method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(d)
    });
    if (r.ok) {
      // Saved to the cloud — the local fallback copy (if any) is now stale;
      // drop it so an old island can never overwrite fresher cloud data.
      try { localStorage.removeItem(`dh_${uid}`); } catch {}
      return true;
    }
  } catch {}
  // Cloud save failed (offline, or expired token): keep a local backup so the
  // change isn't lost. The caller refreshes the token and retries.
  try { localStorage.setItem(`dh_${uid}`, JSON.stringify(d)); } catch {}
  return false;
};

// Merge two copies of a keyed list: union by id, the newer stamp wins a
// conflict, first list wins ties (pass cloud first).
const mergeLists = (a, b) => {
  const stamp = x => (x && (x.updatedAt || x.savedAt)) || "";
  const by = new Map();
  [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].forEach(x => {
    if (!x || !x.id) return;
    const prev = by.get(x.id);
    if (!prev || stamp(x) > stamp(prev)) by.set(x.id, x);
  });
  return [...by.values()];
};
// Cloud wins scalars; the deal/property lists union so a device that saved
// offline contributes its entries instead of being silently shadowed.
const mergeData = (cloud, local) => ({
  ...local, ...cloud,
  savedDeals: mergeLists(cloud.savedDeals, local.savedDeals),
  properties: mergeLists(cloud.properties, local.properties),
  deals:      mergeLists(cloud.deals,      local.deals),
});

const loadData = async (uid, token) => {
  let cloud = null;
  try {
    const r = await fetch(`${dbPath(uid)}?auth=${token}`);
    if (r.ok) { const d = await r.json(); if (d && typeof d === "object") cloud = d; }
  } catch {}
  let local = null;
  try { const raw = localStorage.getItem(`dh_${uid}`); if (raw) local = JSON.parse(raw); } catch {}
  if (cloud && local) {
    // A device that saved offline left changes in its mirror. Merge the two
    // and heal the cloud copy so every device converges on one truth.
    const merged = mergeData(cloud, local);
    await saveData(uid, token, merged); // success also clears the mirror
    return merged;
  }
  return cloud || local;
};
const saveMeta = async (uid, token, m) => {
  try {
    await fetch(`${metaPath(uid)}?auth=${token}`, {
      method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(m)
    });
  } catch {}
};
const loadMeta = async (uid, token) => {
  try {
    const r = await fetch(`${metaPath(uid)}?auth=${token}`);
    if(r.ok) { const d = await r.json(); if(d) return d; }
  } catch {}
  return null;
};
const saveAuth  = u  => { try { localStorage.setItem("dh_auth", JSON.stringify(u)); } catch {} };
const loadAuth  = () => { try { const r = localStorage.getItem("dh_auth"); return r ? JSON.parse(r) : null; } catch { return null; } };
const clearAuth = () => { try { localStorage.removeItem("dh_auth"); } catch {} };

// -- Seed ----------------------------------------------------------------------
const SEED = {
  rentcastKey:"", llcs:["My LLC"], deals:[], auctions:[],
  renoRates:{light:7, medium:13, full:45}, properties:[],
  tier:"free",
  // "user" (default) hides the portfolio/property-management features and
  // shows the Saved Deals dashboard. "admin" exposes the full app — set on
  // the account by writing role:"admin" to /users/{uid}/data in Firebase.
  role:"user",
  // Deals the member has saved from the Deals page (non-admin users) —
  // surfaced on their Dashboard as their personal watchlist.
  savedDeals:[],
};

// -- Finance -------------------------------------------------------------------
const monthlyPI = (principal, rate, years=30) => {
  if (!principal || !rate) return 0;
  const r = rate/100/12, n = years*12;
  return principal * (r * Math.pow(1+r,n)) / (Math.pow(1+r,n)-1);
};

// -- Loans (multi-loan financing) ----------------------------------------------
// A pro forma can carry p.loans = [{financeOf, ltvPct, customAmount, loanType,
// rate, termYears}]. When absent, calc() falls back to the legacy single-loan
// model (downPaymentPct + interestRate) so existing portfolio properties and
// saved analyses keep their exact numbers.
const newLoan = (n=1) => ({
  id: "l" + Date.now() + n,
  financeOf: "purchase",      // purchase | rehab | purchase_rehab | arv | custom
  ltvPct: 75,                 // % of the financed base (ignored for custom)
  customAmount: 0,
  loanType: "amortizing",     // amortizing | interest_only
  rate: 12,
  termYears: 30,
});
const loanBase = (loan, p) =>
  loan.financeOf === "purchase"       ? (p.purchasePrice||0)
: loan.financeOf === "rehab"          ? (p.repairCosts||0)
: loan.financeOf === "purchase_rehab" ? (p.purchasePrice||0) + (p.repairCosts||0)
: loan.financeOf === "arv"            ? (p.homeValueHigh || p.flipSalePrice || 0)
: 0;
const loanAmount = (loan, p) =>
  loan.financeOf === "custom"
    ? (loan.customAmount||0)
    : Math.round(loanBase(loan, p) * ((loan.ltvPct ?? 75)/100));
const loanPayment = (amount, loan) =>
  loan.loanType === "interest_only"
    ? amount * ((loan.rate||12)/100/12)
    : monthlyPI(amount, loan.rate||12, loan.termYears||30);

// -- Itemized costs --------------------------------------------------------------
// Closing/repair costs can be itemized: [{id, name, type, value, rollIn}].
// type: "amount" ($) | "pct_price" (% of purchase) | "pct_loan" (% of loans).
const itemValue = (it, price, loanAmt) =>
  it.type === "pct_price" ? Math.round(price   * (it.value||0)/100)
: it.type === "pct_loan"  ? Math.round(loanAmt * (it.value||0)/100)
: Math.round(it.value||0);
// Monthly value of an operating-expense item: $/mo, $/yr, or % of gross rent.
const expenseMonthly = (it, rent) =>
  it.type === "year"     ? (it.value||0) / 12
: it.type === "pct_rent" ? rent * ((it.value||0) / 100)
: (it.value||0);

const INCOME_PREFILL = () => [
  {id:"oi1", name:"Parking",        type:"amount", value:0, rollIn:false},
  {id:"oi2", name:"Laundry",        type:"amount", value:0, rollIn:false},
  {id:"oi3", name:"Storage Rental", type:"amount", value:0, rollIn:false},
];
// Seeded from whatever's already in the four quick fields so switching to
// itemized never changes the numbers out from under the user.
const EXPENSES_PREFILL = p => [
  {id:"ex1", name:"Property Taxes",       type:"year",     value:(p.expPropTax||0)*12,   rollIn:false},
  {id:"ex2", name:"Insurance",            type:"year",     value:(p.expInsurance||0)*12, rollIn:false},
  {id:"ex3", name:"Property Management",  type:"pct_rent", value:(p.rentAmount||0)>0 ? Math.round(((p.expManagement||0)/(p.rentAmount||1))*100) : 8, rollIn:false},
  {id:"ex4", name:"Maintenance",          type:"pct_rent", value:10, rollIn:false},
  {id:"ex5", name:"Capital Expenditures", type:"pct_rent", value:5,  rollIn:false},
  {id:"ex6", name:"HOA Fees",             type:"amount",   value:0,  rollIn:false},
  {id:"ex7", name:"Utilities",            type:"amount",   value:p.expUtilities||0, rollIn:false},
  {id:"ex8", name:"Landscaping",          type:"amount",   value:0,  rollIn:false},
  {id:"ex9", name:"Accounting & Legal",   type:"amount",   value:0,  rollIn:false},
];
const EXPENSE_TYPES = [
  {value:"amount",   label:"$ Per Month",  input:"$"},
  {value:"year",     label:"$ Per Year",   input:"$"},
  {value:"pct_rent", label:"% of Rent",    input:"%"},
];
const AMOUNT_ONLY_TYPES = [{value:"amount", label:"$ Per Month", input:"$"}];

const itemTotals = (items, price, loanAmt) => {
  const list = Array.isArray(items) ? items : [];
  let upFront = 0, rolled = 0;
  for (const it of list) {
    const v = itemValue(it, price, loanAmt);
    if (it.rollIn) rolled += v; else upFront += v;
  }
  return { upFront, rolled, total: upFront + rolled };
};

const calc = (p) => {
  // "Already own it" mode: no purchase happens. Out-of-pocket is the rehab
  // budget, the existing loan payment carries the hold, a refi or sale pays
  // off the existing balance, and purchasePrice holds today's value.
  const owned    = !!p.alreadyOwned;
  const ownedBal = owned ? (p.ownedLoanBalance||0) : 0;
  const ownedPmt = owned ? (p.ownedLoanPayment||0) : 0;
  const vacancyFactor = 1 - ((p.vacancyRate||0)/100);
  const effectiveRent = (p.rentAmount||0) * vacancyFactor + (p.otherIncome||0);
  const expItemized = Array.isArray(p.expenseItems) && p.expenseItems.length
    ? Math.round(p.expenseItems.reduce((t, it) => t + expenseMonthly(it, p.rentAmount||0), 0))
    : null;
  const exp  = expItemized != null ? expItemized
    : (p.expPropTax||0)+(p.expUtilities||0)+(p.expManagement||0)+(p.expInsurance||0);
  const noi  = effectiveRent - exp;

  // Purchase costs: itemized breakdown wins; otherwise a % of price (default
  // 3%); legacy saves that stored a flat $ amount keep honoring it.
  const ccItemized = Array.isArray(p.closingItems) && p.closingItems.length > 0;
  const cc = owned ? 0
    : ccItemized && p.closingCosts != null
    ? p.closingCosts
    : (p.purchaseCostsPct != null || p.closingCosts == null)
      ? Math.round((p.purchasePrice||0) * ((p.purchaseCostsPct ?? 3) / 100))
      : p.closingCosts;

  // Cash invested includes purchase costs — closing, lender, and title money
  // leaves your pocket just as surely as the price does.
  const cashOOP  = (owned ? 0 : (p.purchasePrice||0)) + (p.repairCosts||0) + cc;
  const cashCF   = effectiveRent - exp - ownedPmt;
  const cashCoC  = cashOOP>0 ? (cashCF*12/cashOOP)*100 : 0;
  // Cap rate is NOI over purchase price (property metric); CoC is cash flow
  // over cash invested (investor metric). Dividing cap by OOP made the two
  // identical on cash deals.
  const cashCap  = (p.purchasePrice||0)>0 ? (noi*12/(p.purchasePrice||0))*100 : 0;
  const hasLoans = Array.isArray(p.loans) && p.loans.length > 0;

  let down, loan, mtg, finOOP, rolledIn = 0, loanBreakdown = [];
  if (hasLoans) {
    // New model: sum every loan; costs marked "roll into loan" ride on top of
    // the first loan (financed, not paid up front).
    const baseAmounts = p.loans.map(l => loanAmount(l, p));
    const baseSum     = baseAmounts.reduce((a,b)=>a+b, 0);
    rolledIn = itemTotals(p.closingItems, p.purchasePrice||0, baseSum).rolled
             + itemTotals(p.repairItems,  p.purchasePrice||0, baseSum).rolled;
    loan = baseSum + rolledIn;
    mtg  = p.loans.reduce((sum, l, i) =>
      sum + loanPayment(baseAmounts[i] + (i===0 ? rolledIn : 0), l), 0);
    loanBreakdown = p.loans.map((l, i) => ({
      loan: l,
      amount: baseAmounts[i] + (i===0 ? rolledIn : 0),
      payment: loanPayment(baseAmounts[i] + (i===0 ? rolledIn : 0), l),
    }));
    finOOP = Math.max(0, (p.purchasePrice||0) + (p.repairCosts||0) + cc - loan);
    down   = Math.max(0, (p.purchasePrice||0) - loan);
  } else {
    // Legacy single-loan model.
    down   = (p.purchasePrice||0) * (p.downPaymentPct||25)/100;
    loan   = (p.purchasePrice||0) - down;
    mtg    = monthlyPI(loan, p.interestRate||7.5);
    finOOP = down + (p.repairCosts||0) + cc;
  }

  const finCF    = effectiveRent - exp - mtg;
  const finCoC   = finOOP>0 ? (finCF*12/finOOP)*100 : 0;
  const finCap   = (p.purchasePrice||0)>0 ? (noi*12/(p.purchasePrice||0))*100 : 0;
  const payoff   = (finCF>0 && finOOP>0) ? finOOP/(finCF*12) : 0;
  const brrrCashOut = p.brrrCashOut || Math.round(((p.homeValueHigh || p.homeValueMedian || 0))*0.75);
  const brrrMtg  = monthlyPI(brrrCashOut, p.brrrRate||7.5, p.brrrTermYears||30);
  const brrrCF   = effectiveRent - exp - brrrMtg;
  // Refinance closing costs come off the top of the new loan's proceeds.
  const brrrRefiCost = Math.round(brrrCashOut * ((p.brrrRefiCostPct ?? 2) / 100));
  const brrrCashNet  = brrrCashOut - brrrRefiCost;

  // Fix & flip: holding costs accrue for the hold period (rehab + sale time).
  const holdMonths  = p.holdMonths ?? 6;
  const flipHolding = holdMonths * (exp + ownedPmt);
  const agentFee = (p.flipSalePrice||0) * (p.agentFeePct||6)/100;
  const flipProfit = (p.flipSalePrice||0) - cashOOP - agentFee - flipHolding - ownedBal;
  const flipROI  = cashOOP>0 ? (flipProfit/cashOOP)*100 : 0;

  // Financed flip: carrying costs include the debt service, the loan gets
  // paid off out of the sale, and ROI is measured on cash actually invested —
  // that's the leverage story.
  const finFlipHolding = holdMonths * (exp + mtg);
  const finFlipProfit  = (p.flipSalePrice||0) - agentFee - finFlipHolding - loan - finOOP;
  const finFlipROI     = finOOP>0 ? (finFlipProfit/finOOP)*100 : 0;

  // Financed BRRRR: the refi pays off the existing loans first; what's left
  // is the cash that actually reaches your pocket.
  const brrrNetCash = brrrCashNet - (owned ? ownedBal : loan);

  const s = p.chosenStrategy || "finance";
  // BRRRR carries the property through the rehab months before the refi —
  // operating costs plus any purchase debt service, no rent assumed until
  // the refinance.
  const brrrHolding = holdMonths * (exp + (owned ? ownedPmt : (s === "cash" ? 0 : mtg)));
  const brrrAllIn   = (s === "cash" ? cashOOP : finOOP) + brrrHolding;
  return {
    exp, noi, effectiveRent, cashOOP, cashCF, cashCoC, cashCap,
    owned, ownedBal, ownedPmt,
    down, loan, mtg, cc, finOOP, finCF, finCoC, finCap, payoff,
    rolledIn, loanBreakdown, holdMonths, flipHolding,
    finFlipHolding, finFlipProfit, finFlipROI, brrrNetCash,
    brrrCashOut, brrrMtg, brrrCF, agentFee, flipProfit, flipROI,
    brrrRefiCost, brrrCashNet, brrrHolding, brrrAllIn,
    chosenCF:  s==="cash" ? cashCF  : finCF,
    chosenCoC: s==="cash" ? cashCoC : finCoC,
    chosenCap: s==="cash" ? cashCap : finCap,
    chosenOOP: s==="cash" ? cashOOP : finOOP,
  };
};

// BRRRR earns the recommendation only when it does what BRRRR is for:
// returning most of your capital. The refi must hand back at least 70% of
// everything in the deal — purchase, purchase costs, rehab, and the rehab-
// months holding costs — net of refi closing costs, and the property must
// still clear $100/mo after the new payment. Mirrors the deal feed's BRRRR
// tag gate in classifyDeal. When the gate fails, BRRRR's card stays visible
// but it can't win, and `reason` powers the "Why not BRRRR" line.
// Callers pass `spent` WITH m.brrrHolding and `backNet` as net proceeds.
const BRRRR_MIN_RECOVERY = 0.7;
const BRRRR_MIN_CF       = 100;
const brrrrGate = (m, spent, backNet) => {
  const back      = Math.max(backNet || 0, 0);
  const recovery  = spent > 0 ? back / spent : 0;
  const leftIn    = Math.max(spent - back, 0);
  const cfOk      = m.brrrCF >= BRRRR_MIN_CF;
  const recOk     = recovery >= BRRRR_MIN_RECOVERY;
  return {
    eligible: cfOk && recOk,
    score:    !(cfOk && recOk) ? 0 : leftIn > 0 ? (m.brrrCF * 12 / leftIn) * 100 : 999,
    reason:   !recOk
      ? `after refi costs and holding it would only return ${Math.round(recovery * 100)}% of your cash, and a solid BRRRR returns at least 70%`
      : `it wouldn't cash flow at least $${BRRRR_MIN_CF}/mo after the refinance`,
    recovery, leftIn,
  };
};

// -- Helpers -------------------------------------------------------------------
const F   = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const $   = n  => "$" + Math.round(n||0).toLocaleString();
const $mo = n  => { const r = Math.round(n||0); return (r<0?"-$":"$") + Math.abs(r).toLocaleString() + "/mo"; };
const pct = n  => (isNaN(n)?0:(n||0)).toFixed(2) + "%";
const cfC = v  => v>0 ? "#059669" : v<0 ? "#dc2626" : "#71717a";
const dU  = d  => { if(!d) return null; return Math.ceil((new Date(d)-new Date())/86400000); };
const obBadge = p => p.occupied ? {label:"Occupied",bg:"#dcfce7",c:"#166534"} : {label:"Vacant",bg:"#f4f4f5",c:"#71717a"};
const stStyle = s => s==="Current"?{bg:"#dcfce7",c:"#166534"}:s==="Late"?{bg:"#fee2e2",c:"#991b1b"}:s==="Partial"?{bg:"#ffedd5",c:"#9a3412"}:{bg:"#f4f4f5",c:"#71717a"};
const svUrl   = (lat,lng,w=800,h=400,heading=null) => "https://maps.googleapis.com/maps/api/streetview?size="+w+"x"+h+"&location="+lat+","+lng+"&fov=90&pitch=0"+(heading!=null?"&heading="+heading:"")+"&key="+GOOGLE_API_KEY;
// Six exterior angles around the pin — a Street View "photo shoot" for
// properties that carry no listing photos.
const svAngles = (lat,lng) => [20, 80, 140, 200, 260, 320].map(h => svUrl(lat, lng, 900, 560, h));
// Haversine miles between two points — used to sort comps nearest-first.
const milesBetween = (lat1, lng1, lat2, lng2) => {
  const toR = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const a = Math.sin(dLat/2)*Math.sin(dLat/2)
    + Math.cos(toR(lat1))*Math.cos(toR(lat2))*Math.sin(dLng/2)*Math.sin(dLng/2);
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};

const newProp = (base={}) => ({
  id:"p"+Date.now(), address:"", city:"", state:"", zip:"", lat:null, lng:null,
  llc:"", type:"", beds:0, baths:0, sqft:0, yearBuilt:0,
  purchasePrice:0, repairCosts:0, rentAmount:0, taxValue:0, parcelId:"",
  homeValueLow:0, homeValueMedian:0, homeValueHigh:0,
  lotSize:0,
  repairLight:0, repairMedium:0, repairFull:0,
  downPaymentPct:25, interestRate:7.5, closingCosts:DEFAULT_CLOSING,
  expPropTax:0, expUtilities:0, expManagement:0, expInsurance:0,
  vacancyRate:5,
  brrrCashOut:0, flipSalePrice:0, agentFeePct:6,
  rentEstimate:0, rentEstLow:0, rentEstHigh:0,
  chosenStrategy:"finance",
  tenantName:"", tenantPhone:"", tenantEmail:"",
  leaseStart:"", leaseEnd:"", rentDeposit:0, tenantStatus:"Vacant", occupied:false,
  lockboxCode:"", notes:"", dealNotes:"", projects:[], ...base
});

const newDeal = () => ({
  id:"d"+Date.now(), address:"", city:"", state:"", zip:"", fullAddress:"", lat:null, lng:null,
  type:"Single Family", beds:0, baths:0, sqft:0, yearBuilt:0, taxValue:0, parcelId:"",
  homeValueLow:0, homeValueMedian:0, homeValueHigh:0,
  lotSize:0,
  repairLight:0, repairMedium:0, repairFull:0,
  purchasePrice:0, repairCosts:0, rentAmount:0,
  rentEstimate:0, rentEstLow:0, rentEstHigh:0,
  downPaymentPct:25, interestRate:7.5, closingCosts:null,
  loans:[], holdMonths:6, purchaseCostsPct:3,
  otherIncome:0, incomeItems:null, expenseItems:null,
  closingItems:null, repairItems:null,
  expPropTax:0, expUtilities:0, expManagement:0, expInsurance:0,
  vacancyRate:5,
  brrrCashOut:0, brrrRate:7.5, brrrTermYears:30, brrrRefiCostPct:2, flipSalePrice:0, agentFeePct:6,
  alreadyOwned:false, ownedLoanBalance:0, ownedLoanPayment:0,
  chosenStrategy:null, notes:"", savedAt:""
});

// Body scroll lock with a counter, so stacked sheets (Deal View with a
// research sheet on top) don't unlock the page when the top one closes.
let dhScrollLocks = 0;
const lockBodyScroll = () => {
  if (++dhScrollLocks === 1) document.body.classList.add("dh-scroll-locked");
};
const unlockBodyScroll = () => {
  dhScrollLocks = Math.max(0, dhScrollLocks - 1);
  if (dhScrollLocks === 0) document.body.classList.remove("dh-scroll-locked");
};

// -- Responsive ----------------------------------------------------------------
function useIsMobile() {
  const [m,setM] = useState(window.innerWidth < 768);
  useEffect(() => {
    const h = () => setM(window.innerWidth < 768);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return m;
}

function useIsWide() {
  const [w,setW] = useState(window.innerWidth >= 1024);
  useEffect(() => {
    const h = () => setW(window.innerWidth >= 1024);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return w;
}

// -- Design System -------------------------------------------------------------
// Polished SaaS palette: zinc neutrals + restrained accents (Linear/Stripe-style).
const C = {
  // Brand / accent — DealHive orange (the `green*` keys are kept to avoid
  // churning hundreds of call sites; they now hold the brand orange).
  green:        "#E8731C",   // logo orange
  greenHover:   "#CC5F12",
  greenDark:    "#C2410C",   // orange-700, for text/icons on light
  greenLight:   "#FFEDD5",   // orange-100 (badge bg)
  greenSubtle:  "#FFF7ED",   // orange-50 (panel tint)
  greenBorder:  "#FDBA74",   // orange-300
  greenMid:     "#EA580C",

  // Sidebar (logo navy)
  sidebar:      "#1F2D3D",
  sidebarHover: "#2C3E52",
  sidebarText:  "#94A3B8",

  // Surfaces & borders (zinc)
  bg:           "#fafafa",
  bgSubtle:     "#f4f4f5",
  card:         "#ffffff",
  border:       "#e4e4e7",
  borderHover:  "#d4d4d8",

  // Text
  text:         "#1F2D3D",   // logo navy for primary text (was near-black)
  textSub:      "#52525b",
  textMuted:    "#a1a1aa",

  // Semantic
  blue:         "#2563eb", blueLight:"#dbeafe", blueDark:"#1e40af", blueSubtle:"#eff6ff", blueBorder:"#bfdbfe",
  amber:        "#d97706", amberLight:"#fef3c7", amberDark:"#92400e", amberSubtle:"#fffbeb", amberBorder:"#fde68a",
  red:          "#dc2626", redLight:"#fee2e2", redDark:"#991b1b", redSubtle:"#fef2f2", redBorder:"#fecaca",
  purple:       "#7c3aed", purpleLight:"#ede9fe", purpleDark:"#5b21b6", purpleSubtle:"#f5f3ff", purpleBorder:"#ddd6fe",
  // True positive-money green (cash flow stays green by financial convention)
  cashPos:      "#059669",

  // Radii
  r1: 6, r2: 8, r3: 10, r4: 12, r5: 16, rFull: 9999,

  // Shadows
  sh1: "0 1px 2px 0 rgba(15,23,42,.04)",
  sh2: "0 1px 3px 0 rgba(15,23,42,.06), 0 1px 2px -1px rgba(15,23,42,.04)",
  sh3: "0 4px 6px -1px rgba(15,23,42,.07), 0 2px 4px -2px rgba(15,23,42,.04)",
  sh4: "0 12px 20px -4px rgba(15,23,42,.10), 0 4px 8px -4px rgba(15,23,42,.05)",
  ring: "0 0 0 3px rgba(232,115,28,.18)",
};

const iS = (mobile=false) => ({
  width:"100%", minWidth:0, border:"1px solid "+C.border, borderRadius:C.r2,
  padding: mobile ? "12px 14px" : "9px 12px",
  fontSize: mobile ? 16 : 14,
  outline:"none", background:C.card, boxSizing:"border-box",
  fontFamily:F, color:C.text, WebkitTextFillColor:C.text,
  transition: "border-color .15s, box-shadow .15s",
});

const btnStyle = (variant="primary", size="md", extra={}) => {
  const v = {
    primary:  {background:C.green,        color:"#ffffff",  border:"1px solid "+C.green,       boxShadow:C.sh1},
    secondary:{background:C.card,         color:C.text,     border:"1px solid "+C.border,      boxShadow:C.sh1},
    danger:   {background:C.card,         color:C.redDark,  border:"1px solid "+C.redBorder,   boxShadow:C.sh1},
    ghost:    {background:"transparent",  color:C.textSub,  border:"1px solid transparent"},
    blue:     {background:C.blue,         color:"#ffffff",  border:"1px solid "+C.blue,        boxShadow:C.sh1},
    dark:     {background:C.sidebar,      color:"#ffffff",  border:"1px solid "+C.sidebar,     boxShadow:C.sh1},
  };
  const s = {
    sm:  {padding:"5px 11px",  fontSize:12, borderRadius:C.r1, height:28},
    md:  {padding:"8px 14px",  fontSize:13, borderRadius:C.r2, height:36},
    lg:  {padding:"10px 18px", fontSize:14, borderRadius:C.r2, height:42},
    xl:  {padding:"13px 22px", fontSize:15, borderRadius:C.r2, height:48},
  };
  return {
    className: "dh-btn-" + variant,
    style: {
      ...v[variant], ...s[size], cursor:"pointer", fontWeight:600, fontFamily:F,
      display:"inline-flex", alignItems:"center", justifyContent:"center", gap:6,
      letterSpacing:"-0.005em", textDecoration:"none",
      transition:"background-color .15s, border-color .15s, box-shadow .15s, transform .05s",
      WebkitTapHighlightColor:"transparent",
      ...extra,
    },
  };
};

// -- Google Maps ---------------------------------------------------------------
let gmLoaded = false;
const loadGM = () => new Promise(resolve => {
  if (window.google?.maps) { resolve(); return; }
  if (gmLoaded) { const t=setInterval(()=>{ if(window.google?.maps){clearInterval(t);resolve();} },100); return; }
  gmLoaded = true;
  const s = document.createElement("script");
  s.src = "https://maps.googleapis.com/maps/api/js?key="+GOOGLE_API_KEY+"&libraries=places";
  s.onload = resolve; document.head.appendChild(s);
});

function AddressInput({value, onChange, onSelect, placeholder="Search address...", mobile=false}) {
  const ref = useRef(null), ac = useRef(null);
  useEffect(() => {
    loadGM().then(() => {
      if (!ref.current || ac.current) return;
      const a = new window.google.maps.places.Autocomplete(ref.current, {
        types:["address"], componentRestrictions:{country:"us"}
      });
      a.addListener("place_changed", () => {
        const place = a.getPlace(); if (!place.geometry) return;
        const comp = place.address_components || [];
        const get = t => comp.find(c=>c.types.includes(t))?.long_name || "";
        const gS  = t => comp.find(c=>c.types.includes(t))?.short_name || "";
        onSelect({
          address: (get("street_number")+" "+get("route")).trim(),
          city:    get("locality") || get("sublocality"),
          state:   gS("administrative_area_level_1"),
          zip:     get("postal_code"),
          lat:     place.geometry.location.lat(),
          lng:     place.geometry.location.lng(),
          fullAddress: place.formatted_address
        });
      });
      ac.current = a;
    });
  }, []);
  return (
    <input ref={ref} type="text" value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder} style={iS(mobile)} autoComplete="off" />
  );
}

// -- RentCast property data ----------------------------------------------------
// One provider for everything: property record, value estimate (AVM) and
// long-term rent estimate. Each call is wrapped by the caller in apiLookup()
// for caching + the monthly cap.
const rentcastFetch = async (addr, city, state, zip, auth) => {
  const full = [addr, [city, state].filter(Boolean).join(" "), zip].filter(Boolean).join(", ");
  const q = encodeURIComponent(full);
  const out = {};
  try { const d = await rcGet(`/properties?address=${q}`, auth); if(Array.isArray(d) && d[0]) out.property=d[0]; } catch {}
  try { const d = await rcGet(`/avm/value?address=${q}`, auth); if(d && (d.price || d.priceRangeLow)) out.value=d; } catch {}
  try { const d = await rcGet(`/avm/rent/long-term?address=${q}`, auth); if(d && d.rent) out.rent=d; } catch {}
  return out;
};

// Did a RentCast pull return anything usable?
const rcHasData = data => !!(data && (data.property || data.value || data.rent));

// Latest entry in RentCast's year-keyed maps (taxAssessments, propertyTaxes).
const rcLatestYear = obj => {
  if (!obj || typeof obj !== "object") return null;
  const years = Object.keys(obj).sort();
  return years.length ? obj[years[years.length - 1]] : null;
};

const applyRentcast = (prev, data, rates) => {
  const p      = data.property || {};
  const val    = data.value || {};
  const rent   = data.rent || {};
  const assess = rcLatestYear(p.taxAssessments) || {};
  const taxRec = rcLatestYear(p.propertyTaxes) || {};
  const assessedVal = assess.value || 0;
  // Ohio: the Tax value field should hold the market value (what tax is based
  // on), and assessed value is 35% of market — so market = assessed / 0.35.
  const taxVal = (isOhio(prev) && assessedVal)
    ? Math.round(assessedVal / OH_ASSESS_RATIO)
    : (assessedVal || prev.taxValue || 0);
  const annual = taxRec.total || 0;
  const sqft   = p.squareFootage || prev.sqft || 0;
  const med    = val.price || prev.homeValueMedian || 0;
  const lo     = val.priceRangeLow  || (med ? Math.round(med * 0.9) : prev.homeValueLow);
  const hi     = val.priceRangeHigh || (med ? Math.round(med * 1.1) : prev.homeValueHigh);
  const rentEst     = rent.rent || prev.rentEstimate || 0;
  const rentEstLow  = rent.rentRangeLow  || (rentEst ? Math.round(rentEst * 0.9) : prev.rentEstLow);
  const rentEstHigh = rent.rentRangeHigh || (rentEst ? Math.round(rentEst * 1.1) : prev.rentEstHigh);
  const r = rates || {light:7, medium:13, full:45};
  return {
    ...prev,
    beds:      p.bedrooms     || prev.beds,
    baths:     p.bathrooms    || prev.baths,
    sqft,
    lotSize:   p.lotSize      || prev.lotSize || 0,
    yearBuilt: p.yearBuilt    || prev.yearBuilt,
    taxValue:  taxVal,
    parcelId:  p.assessorID   || prev.parcelId,
    lat:       p.latitude  || val.latitude  || rent.latitude  || prev.lat,
    lng:       p.longitude || val.longitude || rent.longitude || prev.lng,
    type:      p.propertyType || prev.type,
    // Actual recorded tax bill wins — but only when it's plausible (some
    // records carry partial/abated amounts like $120/yr that wreck the
    // pro forma). Below 0.2% of value annually, fall back to the state rate.
    expPropTax: (annual && annual >= Math.max(taxVal, prev.purchasePrice||0, 20000) * 0.002)
                ? Math.round(annual / 12)
              : taxVal ? Math.round(taxVal * (STATE_TAX_RATES[(prev.state||"").toUpperCase()] || DEFAULT_TAX_RATE) / 12)
              : prev.expPropTax,
    expPropTaxAuto: (annual || taxVal) ? false : prev.expPropTaxAuto,
    // Insurance estimated from value and the state's effective rate — only
    // when the user hasn't already entered their own number.
    expInsurance: (prev.expInsurance||0) > 0 ? prev.expInsurance
      : Math.round(((med || taxVal || prev.purchasePrice || 0)
          * (INSURANCE_RATES[(prev.state||"").toUpperCase()] || DEFAULT_INS_RATE)) / 12),
    homeValueMedian: med, homeValueLow: lo, homeValueHigh: med || hi,
    flipSalePrice: med || hi || prev.flipSalePrice,
    brrrCashOut:   med ? Math.round(med * 0.75) : prev.brrrCashOut,
    repairLight:   sqft ? Math.round(sqft * r.light)  : prev.repairLight,
    repairMedium:  sqft ? Math.round(sqft * r.medium) : prev.repairMedium,
    repairFull:    sqft ? Math.round(sqft * r.full)   : prev.repairFull,
    rentEstimate:  rentEst,
    rentEstLow,
    rentEstHigh,
    // Auto-fill rent with estimate if rent is 0
    rentAmount: prev.rentAmount || rentEst,
  };
};

// -- Icons (inline SVG, lucide-style) ------------------------------------------
const IconSvg = ({d, size=16, stroke=2, fill="none"}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor"
    strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0, display:"block"}}>
    {typeof d === "string" ? <path d={d} /> : d}
  </svg>
);
const I = {
  home:        p => <IconSvg {...p} d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1h-5v-7H9v7H4a1 1 0 01-1-1V9.5z"/>,
  building:    p => <IconSvg {...p} d={<g><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9v.01"/><path d="M9 12v.01"/><path d="M9 15v.01"/><path d="M9 18v.01"/></g>}/>,
  search:      p => <IconSvg {...p} d={<g><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></g>}/>,
  chart:       p => <IconSvg {...p} d={<g><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-6"/></g>}/>,
  settings:    p => <IconSvg {...p} d={<g><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h.01a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v.01a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></g>}/>,
  plus:        p => <IconSvg {...p} d={<g><path d="M12 5v14"/><path d="M5 12h14"/></g>}/>,
  arrowLeft:   p => <IconSvg {...p} d={<g><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></g>}/>,
  arrowRight:  p => <IconSvg {...p} d={<g><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></g>}/>,
  chevronRight:p => <IconSvg {...p} d="M9 18l6-6-6-6"/>,
  cycle:       p => <IconSvg {...p} d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/>,
  dollar:      p => <IconSvg {...p} d={<g><path d="M12 2v20"/><path d="M17 6c0-1.7-2.2-3-5-3S7 4.3 7 6s1.6 2.7 5 3.3S17 11 17 13s-2.2 3-5 3-5-1.3-5-3"/></g>}/>,
  tag:         p => <IconSvg {...p} d={<g><path d="M20.6 13.4L11 3.8A2 2 0 009.6 3H5a2 2 0 00-2 2v4.6c0 .5.2 1 .6 1.4l9.6 9.6a2 2 0 002.8 0l4.6-4.6a2 2 0 000-2.6z"/><circle cx="7.5" cy="7.5" r="1"/></g>}/>,
  receipt:     p => <IconSvg {...p} d={<g><path d="M5 3h14v18l-2.3-1.5L14 21l-2-1.5L10 21l-2.7-1.5L5 21z"/><path d="M9 8h6"/><path d="M9 12h6"/></g>}/>,
  trendingUp:  p => <IconSvg {...p} d={<g><path d="M3 17l6-6 4 4 7-8"/><path d="M14 7h6v6"/></g>}/>,
  hammer:      p => <IconSvg {...p} d={<g><path d="M14 4l6 6-2.2 2.2-6-6z"/><path d="M12.8 6.2L4 15a2.8 2.8 0 104 4l8.8-8.8"/></g>}/>,
  bed:         p => <IconSvg {...p} d={<g><path d="M3 7v11"/><path d="M3 16h18"/><path d="M21 16v-5a3 3 0 00-3-3h-7v8"/><circle cx="7" cy="10" r="2"/></g>}/>,
  bath:        p => <IconSvg {...p} d={<g><path d="M4 12h16v2a5 5 0 01-5 5H9a5 5 0 01-5-5v-2z"/><path d="M6 12V5a2 2 0 012-2h1"/><path d="M7 19l-1 2M17 19l1 2"/></g>}/>,
  ruler:       p => <IconSvg {...p} d={<g><rect x="2.5" y="9" width="19" height="6" rx="1.5" transform="rotate(-32 12 12)"/><path d="M8 12.5l1.2 2M11.5 10.5l1.2 2M15 8.5l1.2 2"/></g>}/>,
  calendar:    p => <IconSvg {...p} d={<g><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></g>}/>,
  parcel:      p => <IconSvg {...p} d={<g><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16M12 4v16"/></g>}/>,
  chevronLeft: p => <IconSvg {...p} d="M15 18l-6-6 6-6"/>,
  lock:        p => <IconSvg {...p} d={<g><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></g>}/>,
  star:        p => <IconSvg {...p} d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>,
  chevronDown: p => <IconSvg {...p} d="M6 9l6 6 6-6"/>,
  trash:       p => <IconSvg {...p} d={<g><path d="M3 6h18"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></g>}/>,
  menu:        p => <IconSvg {...p} d={<g><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></g>}/>,
  user:        p => <IconSvg {...p} d={<g><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/></g>}/>,
  edit:        p => <IconSvg {...p} d={<g><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></g>}/>,
  alert:       p => <IconSvg {...p} d={<g><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></g>}/>,
  check:       p => <IconSvg {...p} d="M20 6L9 17l-5-5"/>,
  x:           p => <IconSvg {...p} d={<g><path d="M18 6L6 18"/><path d="M6 6l12 12"/></g>}/>,
  externalLink:p => <IconSvg {...p} d={<g><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></g>}/>,
  phone:       p => <IconSvg {...p} d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/>,
  message:     p => <IconSvg {...p} d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>,
  pin:         p => <IconSvg {...p} d={<g><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></g>}/>,
  bee:         p => <IconSvg {...p} stroke={1.8} d={<g><ellipse cx="12" cy="13" rx="5" ry="6"/><path d="M7 11h10M7 14h10"/><circle cx="9" cy="9" r="2.2" fill="rgba(255,255,255,.3)"/><circle cx="15" cy="9" r="2.2" fill="rgba(255,255,255,.3)"/><path d="M10 6.5L8 4M14 6.5L16 4"/></g>}/>,
  clipboardCheck: p => <IconSvg {...p} d={<g><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><path d="M9 14l2 2 4-4"/></g>}/>,
  camera:      p => <IconSvg {...p} d={<g><path d="M14.5 4h-5L7 7H4a2 2 0 00-2 2v9a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></g>}/>,
  flag:        p => <IconSvg {...p} d={<g><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></g>}/>,
  clock:       p => <IconSvg {...p} d={<g><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></g>}/>,
  messageSquare:p => <IconSvg {...p} d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/>,
};

// Follow-up "type" taxonomy. 10% tint background, full-saturation text/border.
const TYPE_PALETTE = {
  repair:     {color:"#d97706", bg:"rgba(245,158,11,.10)",  border:"rgba(245,158,11,.30)", label:"Repair"},
  inspection: {color:"#9333ea", bg:"rgba(168,85,247,.10)",  border:"rgba(168,85,247,.30)", label:"Inspection"},
  waiting:    {color:"#2563eb", bg:"rgba(59,130,246,.10)",  border:"rgba(59,130,246,.30)", label:"Waiting"},
  admin:      {color:"#475569", bg:"rgba(100,116,139,.10)", border:"rgba(100,116,139,.25)", label:"Admin"},
  tenant:     {color:"#0d9488", bg:"rgba(20,184,166,.10)",  border:"rgba(20,184,166,.30)", label:"Tenant"},
  other:      {color:"#71717a", bg:"rgba(161,161,170,.10)", border:"rgba(161,161,170,.25)", label:"Other"},
};
const TYPE_KEYS = ["repair","inspection","waiting","admin","tenant","other"];
const typeOf = (pr) => (pr && pr.type && TYPE_PALETTE[pr.type]) ? pr.type : "other";

function TypePill({type="other", size="sm", onClick, style={}}) {
  const t = TYPE_PALETTE[type] || TYPE_PALETTE.other;
  return (
    <span onClick={onClick} style={{
      display:"inline-flex", alignItems:"center", flexShrink:0,
      padding: size==="md" ? "3px 10px" : "2px 8px",
      borderRadius:9999, fontSize: size==="md"?12:11, fontWeight:600,
      color:t.color, background:t.bg, border:"1px solid "+t.border,
      letterSpacing:"-0.005em", lineHeight:1.3,
      fontFamily:F, whiteSpace:"nowrap",
      cursor: onClick ? "pointer" : "default",
      ...style,
    }}>{t.label}</span>
  );
}

function TypePicker({value, onChange}) {
  return (
    <div style={{display:"flex", gap:5, flexWrap:"wrap"}}>
      {TYPE_KEYS.map(key => {
        const t = TYPE_PALETTE[key];
        const active = value === key;
        return (
          <button key={key} type="button" onClick={()=>onChange(key)} style={{
            background: active ? t.bg : "transparent",
            color: active ? t.color : C.textSub,
            border: "1px solid " + (active ? t.border : C.border),
            borderRadius: 9999, padding: "4px 10px", fontSize: 12, fontWeight: 600,
            fontFamily: F, cursor: "pointer", letterSpacing:"-0.005em",
            transition: "background .12s, color .12s, border-color .12s",
          }}>{t.label}</button>
        );
      })}
    </div>
  );
}

// -- UI Primitives -------------------------------------------------------------
function Card({children, style={}, hover=false, onClick, onMouseEnter, onMouseLeave, padding, id, className}) {
  const [h, setH] = useState(false);
  return (
    <div id={id} className={className} onClick={onClick}
      onMouseEnter={e => { if (hover) setH(true); onMouseEnter && onMouseEnter(e); }}
      onMouseLeave={e => { if (hover) setH(false); onMouseLeave && onMouseLeave(e); }}
      style={{
        background:C.card, borderRadius:C.r4,
        border:"1px solid "+(hover && h ? C.borderHover : C.border),
        boxShadow: hover && h ? C.sh3 : C.sh1,
        overflow:"hidden",
        transition:"border-color .15s, box-shadow .15s, transform .15s",
        transform: hover && h ? "translateY(-1px)" : "none",
        ...(padding!==undefined ? {padding} : {}),
        ...style,
      }}>
      {children}
    </div>
  );
}

function PageHeader({title, subtitle, action}) {
  return (
    <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:28, gap:16, flexWrap:"wrap"}}>
      <div>
        <h1 style={{margin:0, fontSize:24, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.02em"}}>{title}</h1>
        {subtitle && <p style={{margin:"4px 0 0", fontSize:14, color:C.textSub, fontFamily:F}}>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

function StatCard({label, value, sub, color, icon}) {
  return (
    <Card style={{padding:18}}>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8}}>
        <div style={{minWidth:0, flex:1}}>
          <div style={{fontSize:12, color:C.textSub, fontWeight:500, fontFamily:F, marginBottom:8}}>{label}</div>
          <div style={{fontSize:24, fontWeight:700, color:color||C.text, fontFamily:F, lineHeight:1.1, letterSpacing:"-0.02em"}}>{value}</div>
          {sub && <div style={{fontSize:12, color:C.textMuted, marginTop:6, fontFamily:F}}>{sub}</div>}
        </div>
        {icon && (
          <div style={{width:32, height:32, borderRadius:C.r2, background:C.bgSubtle,
            display:"flex", alignItems:"center", justifyContent:"center", color:C.textSub, flexShrink:0}}>
            {icon}
          </div>
        )}
      </div>
    </Card>
  );
}

function SectionBlock({title, color=C.green, icon=null, children, right, collapsible=false, defaultOpen=true}) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = icon;
  return (
    <Card style={{marginBottom:14, padding:0, boxShadow:C.sh2, overflow:"hidden"}}>
      <div style={{
        padding:"13px 16px",
        display:"flex", justifyContent:"space-between", alignItems:"center",
        background:`linear-gradient(90deg, ${color}14 0%, ${C.card} 62%)`,
        borderBottom: open ? "1px solid "+C.border : "none",
        borderLeft: "3px solid "+color,
        cursor: collapsible ? "pointer" : "default"}}
        onClick={collapsible ? ()=>setOpen(o=>!o) : undefined}>
        <div style={{display:"flex", alignItems:"center", gap:11, minWidth:0}}>
          <div style={{
            width:30, height:30, borderRadius:8, flexShrink:0,
            background:`${color}1f`, color,
            display:"flex", alignItems:"center", justifyContent:"center",
          }}>
            {Icon ? <Icon size={16} stroke={2.2}/> : <span style={{width:10, height:10, borderRadius:3, background:color}}/>}
          </div>
          <span style={{color:C.text, fontWeight:700, fontSize:16, fontFamily:F, letterSpacing:"-0.02em",
            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{title}</span>
        </div>
        <div style={{display:"flex", gap:8, alignItems:"center", flexShrink:0}}>
          {right}
          {collapsible && (
            <span style={{color:C.textMuted, transition:"transform .2s",
              transform:open?"rotate(180deg)":"none", display:"inline-flex"}}>
              <I.chevronDown size={16}/>
            </span>
          )}
        </div>
      </div>
      {open && <div style={{padding:"16px"}}>{children}</div>}
    </Card>
  );
}

function DataRow({label, value, color}) {
  return (
    <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", borderBottom:"1px solid "+C.bg}}>
      <span style={{fontSize:13, color:C.textSub, fontFamily:F}}>{label}</span>
      <span style={{fontSize:13, fontWeight:600, color:color||C.text, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>{value}</span>
    </div>
  );
}

// FIXED: clear field on focus so typing replaces 0
function InputField({label, val, set, type="number", suf, pre, note, mobile=false, plain=false}) {
  const isNum = type === "number";
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef(null);
  const caretRef = useRef(null); // raw chars (digits/dot) left of the caret

  // Strip everything but digits and the first decimal point.
  const sanitize = v => v.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
  // Thousands commas on the integer part, decimals left as typed.
  const addCommas = raw => {
    if (plain) return raw;
    if (raw === "") return "";
    const dot = raw.indexOf(".");
    const int = dot === -1 ? raw : raw.slice(0, dot);
    const dec = dot === -1 ? null : raw.slice(dot + 1);
    const intFmt = int === "" ? "" : Number(int).toLocaleString("en-US");
    return dec === null ? intFmt : `${intFmt}.${dec}`;
  };

  // Numbers format live as you type; the caret is restored to sit after the
  // same digit it was on, however many commas appear or disappear around it.
  const display = !isNum
    ? (val ?? "")
    : focused
      ? draft
      : (val === "" || val == null ? "" : plain ? String(val) : Number(val).toLocaleString());

  useLayoutEffect(() => {
    if (caretRef.current == null || !inputRef.current) return;
    const f = draft;
    let pos = 0, seen = 0;
    while (pos < f.length && seen < caretRef.current) {
      if (/[0-9.]/.test(f[pos])) seen++;
      pos++;
    }
    inputRef.current.setSelectionRange(pos, pos);
    caretRef.current = null;
  }, [draft]);

  const onFocus = () => {
    if (isNum) setDraft(val && Number(val) !== 0 ? addCommas(String(val)) : "");
    setFocused(true);
  };
  const onChange = e => {
    if (!isNum) { set(e.target.value); return; }
    const el = e.target;
    caretRef.current = el.value.slice(0, el.selectionStart ?? el.value.length).replace(/[^0-9.]/g, "").length;
    const raw = sanitize(el.value);
    setDraft(addCommas(raw));
    set(raw === "" ? 0 : (parseFloat(raw) || 0));
  };

  return (
    <div style={{marginBottom:14}}>
      <div style={{display:"flex", justifyContent:"space-between", marginBottom:6}}>
        <label style={{fontSize:13, color:C.text, fontWeight:500, fontFamily:F}}>{label}</label>
        {note && <span style={{fontSize:11, color:C.textMuted, fontFamily:F}}>{note}</span>}
      </div>
      <div style={{position:"relative", display:"flex", alignItems:"stretch"}}>
        {pre && (
          <span style={{
            position:"absolute", left:1, top:1, bottom:1,
            display:"flex", alignItems:"center", justifyContent:"center",
            paddingLeft:12, paddingRight:0,
            fontSize:14, color:C.textMuted, fontFamily:F,
            pointerEvents:"none",
          }}>{pre}</span>
        )}
        <input ref={inputRef} type={isNum ? "text" : type} value={display}
          inputMode={isNum ? "decimal" : undefined}
          onFocus={onFocus}
          onBlur={()=>setFocused(false)}
          onChange={onChange}
          className="dh-input"
          style={{
            ...iS(mobile), flex:1,
            paddingLeft: pre ? (mobile?32:28) : (mobile?14:12),
            paddingRight: suf ? (mobile?38:32) : (mobile?14:12),
            fontVariantNumeric: isNum ? "tabular-nums" : "normal",
          }} />
        {suf && (
          <span style={{
            position:"absolute", right:1, top:1, bottom:1,
            display:"flex", alignItems:"center", justifyContent:"center",
            paddingRight:12, paddingLeft:0,
            fontSize:14, color:C.textMuted, fontFamily:F,
            pointerEvents:"none",
          }}>{suf}</span>
        )}
      </div>
    </div>
  );
}

function Badge({label, bg, c, dot=false}) {
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:6,
      background:bg, color:c, padding:"3px 9px", borderRadius:C.rFull,
      fontSize:11, fontWeight:600, fontFamily:F, whiteSpace:"nowrap",
      letterSpacing:"-0.005em",
    }}>
      {dot && <span style={{width:6, height:6, borderRadius:"50%", background:c}} />}
      {label}
    </span>
  );
}

function EmptyState({icon, title, body, action}) {
  return (
    <Card style={{padding:48, textAlign:"center"}}>
      {icon && (
        <div style={{
          width:48, height:48, borderRadius:C.r3, background:C.bgSubtle,
          display:"inline-flex", alignItems:"center", justifyContent:"center",
          color:C.textMuted, marginBottom:14,
        }}>{icon}</div>
      )}
      <div style={{fontSize:16, fontWeight:600, color:C.text, fontFamily:F, letterSpacing:"-0.01em"}}>{title}</div>
      {body && <div style={{fontSize:13, color:C.textSub, fontFamily:F, marginTop:6, maxWidth:360, marginLeft:"auto", marginRight:"auto"}}>{body}</div>}
      {action && <div style={{marginTop:18}}>{action}</div>}
    </Card>
  );
}

// <img> that fails closed: if the src errors (dead CDN link, Street View
// key/billing rejection, expired listing photo), render `fallback` instead
// of the browser's broken-image icon. Resets when src changes.
// Fixed, whisper-quiet hive backdrop behind every logged-in page. Content
// sits in a zIndex:1 wrapper above it; opacities stay low so cards and text
// keep full contrast.
function AppHexBg() {
  const Hexa = ({size, color, opacity, outline=false, blur=0, style}) => (
    <svg width={size} height={size*1.15} viewBox="0 0 100 115" aria-hidden="true"
      style={{position:"absolute", pointerEvents:"none", opacity,
        filter: blur ? `blur(${blur}px)` : "none", ...style}}>
      <polygon points="50,6 94,31 94,84 50,109 6,84 6,31"
        fill={outline ? "none" : color} stroke={color} strokeWidth="11" strokeLinejoin="round"/>
    </svg>
  );
  return (
    <div aria-hidden="true" style={{position:"fixed", inset:0, zIndex:0, pointerEvents:"none", overflow:"hidden"}}>
      <Hexa size={360} color={C.greenLight}  opacity={0.38} blur={48} style={{top:-110, right:-90}}/>
      <Hexa size={120} color={C.greenBorder} opacity={0.16} outline style={{top:"24%", left:-44}}/>
      <Hexa size={54}  color={C.green}       opacity={0.07} style={{top:"11%", right:"24%"}}/>
      <Hexa size={280} color={C.greenLight}  opacity={0.32} blur={42} style={{bottom:-100, left:"16%"}}/>
      <Hexa size={92}  color={C.greenBorder} opacity={0.14} outline style={{bottom:"20%", right:"5%"}}/>
    </div>
  );
}

function SafeImg({src, alt="", style, fallback=null, ...rest}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) return fallback;
  return <img src={src} alt={alt} style={style} onError={()=>setFailed(true)} {...rest}/>;
}

// Centered building-icon placeholder used wherever a photo is missing/broken.
const imgPlaceholder = (size=28) => (
  <div style={{height:"100%", display:"flex", alignItems:"center", justifyContent:"center", color:C.textMuted}}>
    <I.building size={size}/>
  </div>
);

function StreetViewImg({lat, lng, address, height=200}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [lat, lng]);
  // Hide the whole strip if Street View can't serve the image — an address
  // banner over a broken-image icon looks worse than no strip at all.
  if (!lat || !lng || failed) return null;
  return (
    <div style={{position:"relative", borderRadius:C.r4, overflow:"hidden", marginBottom:16,
      border:"1px solid "+C.border, boxShadow:C.sh1}}>
      <img src={svUrl(lat,lng,900,height*2)} alt="Street View" onError={()=>setFailed(true)}
        style={{width:"100%", height, objectFit:"cover", display:"block"}} />
      <div style={{position:"absolute", inset:0, background:"linear-gradient(to bottom,transparent 50%,rgba(9,9,11,.65))"}} />
      <div style={{position:"absolute", bottom:12, left:14, right:14, display:"flex", justifyContent:"space-between", alignItems:"flex-end", gap:10}}>
        <div style={{color:"white", fontWeight:600, fontSize:14, fontFamily:F, letterSpacing:"-0.01em",
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{address}</div>
        <a href={"https://maps.google.com/?q="+lat+","+lng} target="_blank" rel="noreferrer"
          style={{background:"rgba(255,255,255,.95)", color:C.text, padding:"5px 11px",
            borderRadius:C.r1, fontSize:12, fontWeight:600, textDecoration:"none", fontFamily:F,
            display:"inline-flex", alignItems:"center", gap:5, flexShrink:0}}>
          Maps <I.externalLink size={11} stroke={2.5}/>
        </a>
      </div>
    </div>
  );
}

function TrialBanner({daysLeft}) {
  if (daysLeft === null || daysLeft > TRIAL_DAYS) return null;
  const expired = daysLeft <= 0;
  return (
    <div style={{
      background: expired ? C.redSubtle : C.amberSubtle,
      borderBottom: "1px solid " + (expired ? C.redBorder : C.amberBorder),
      padding:"10px 24px", display:"flex", justifyContent:"space-between", alignItems:"center", gap:12,
    }}>
      <div style={{display:"flex", alignItems:"center", gap:10, fontSize:13, fontFamily:F,
        color: expired ? C.redDark : C.amberDark, fontWeight:500}}>
        <I.alert size={15}/>
        <span>
          {expired
            ? "Your free trial has expired"
            : <>Free trial: <b style={{fontWeight:700}}>{daysLeft} day{daysLeft===1?"":"s"} remaining</b></>}
        </span>
      </div>
      <button {...btnStyle("primary","sm")}>{expired ? "Renew now" : "Upgrade to Pro"}</button>
    </div>
  );
}

// -- Auth Page -----------------------------------------------------------------
function AuthPage({onAuth}) {
  const [mode,setMode]     = useState("signin");
  const [email,setEmail]   = useState("");
  const [password,setPass] = useState("");
  const [confirm,setConf]  = useState("");
  const [loading,setL]     = useState(false);
  const [err,setErr]       = useState("");
  const [msg,setMsg]       = useState("");
  const mobile = useIsMobile();

  const submit = async e => {
    e.preventDefault(); setErr(""); setMsg("");
    if (mode==="signup" && password !== confirm) { setErr("Passwords do not match."); return; }
    if (mode==="signup" && password.length < 6)  { setErr("Password must be at least 6 characters."); return; }
    setL(true);
    try {
      if (mode==="reset") {
        await fbResetPassword(email);
        setMsg("Reset email sent! Check your inbox."); setMode("signin");
      } else {
        const u = mode==="signup" ? await fbSignUp(email,password) : await fbSignIn(email,password);
        onAuth(u, mode==="signup");
      }
    } catch(ex) {
      const m = ex.message;
      setErr(
        m.includes("EMAIL_EXISTS")                          ? "Account already exists." :
        m.includes("INVALID_LOGIN_CREDENTIALS")||
        m.includes("INVALID_PASSWORD")                      ? "Invalid email or password." :
        m.includes("EMAIL_NOT_FOUND")                       ? "No account found." :
        m.includes("TOO_MANY_ATTEMPTS")                     ? "Too many attempts. Try again later." : m
      );
    }
    setL(false);
  };

  // Social sign-in. Google runs a real OAuth flow once the client ID is
  // configured; Apple and Facebook are visible but marked coming soon until
  // their provider setups exist.
  const googleSignIn = () => {
    setErr(""); setMsg("");
    if (!GOOGLE_OAUTH_CLIENT_ID) {
      setMsg("Google sign-in is coming online shortly — use email for now.");
      return;
    }
    const launch = () => {
      let client;
      try {
        client = window.google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_OAUTH_CLIENT_ID,
          scope: "openid email profile",
          // Fires when the popup can't open or closes early — without this,
          // a misconfigured origin makes the button look like it does nothing.
          error_callback: (e) => {
            setL(false);
            setErr(e && (e.type === "popup_closed" || e.type === "user_cancel")
              ? "Google sign-in was cancelled."
              : "Google sign-in couldn't open (" + ((e && e.type) || "blocked") + "). Try email instead.");
          },
          callback: async (resp) => {
            if (!resp || !resp.access_token) {
              setL(false);
              setErr(resp && resp.error
                ? "Google sign-in failed (" + resp.error + "). Try email instead."
                : "Google sign-in was cancelled.");
              return;
            }
            setL(true);
            try {
              const u = await fbSignInWithIdp(`access_token=${resp.access_token}&providerId=google.com`);
              onAuth(u, !!u.isNewUser);
            } catch (ex) {
              const m = String((ex && ex.message) || "");
              setErr(
                m.includes("UNAUTHORIZED_DOMAIN")    ? "This domain isn't authorized for Google sign-in yet — use email for now." :
                m.includes("OPERATION_NOT_ALLOWED")  ? "Google sign-in isn't enabled on the account system yet — use email for now." :
                "Google sign-in failed (" + (m || "unknown") + "). Try email instead.");
            }
            setL(false);
          },
        });
      } catch {
        setErr("Google sign-in couldn't start. Try email instead.");
        return;
      }
      client.requestAccessToken();
    };
    if (window.google?.accounts?.oauth2) { launch(); return; }
    const sc = document.createElement("script");
    sc.src = "https://accounts.google.com/gsi/client";
    sc.onload = launch;
    sc.onerror = () => setErr("Couldn't reach Google. Try email instead.");
    document.head.appendChild(sc);
  };
  const comingSoon = name => { setErr(""); setMsg(`${name} sign-in is coming soon — use email or Google for now.`); };

  const linkBtn = {
    background:"none", border:"none", padding:0, color:C.green, fontWeight:600,
    cursor:"pointer", fontFamily:F, fontSize:13, letterSpacing:"-0.005em",
  };
  const socialBtn = {
    display:"flex", alignItems:"center", justifyContent:"center", gap:8,
    padding:"11px 10px", borderRadius:C.r3, border:"1px solid "+C.border,
    background:"#fff", cursor:"pointer", fontFamily:F, fontSize:13.5, fontWeight:600,
    color:C.text, boxShadow:C.sh1, transition:"border-color .12s, box-shadow .12s",
  };

  const perks = [
    "Live data on 140M+ U.S. properties",
    "Buy & Hold, BRRRR & Fix & Flip verdicts",
    "Real financing: multiple loans, interest-only",
    "Free plan, no credit card",
  ];

  return (
    <div style={{padding: mobile ? "14px 16px 16px" : "26px 20px 30px", background:C.bg,
      backgroundImage:`radial-gradient(circle at 85% 0%, ${C.greenSubtle} 0%, transparent 42%), radial-gradient(circle at 0% 100%, ${C.bgSubtle} 0%, transparent 50%)`}}>
      <div className="dh-auth-grid" style={{
        maxWidth:920, margin:"0 auto",
        display:"grid", gridTemplateColumns:"1fr 1.1fr", gap:0,
        borderRadius:22, overflow:"hidden",
        boxShadow:"0 32px 64px -24px rgba(15,23,42,.28), 0 6px 18px -8px rgba(15,23,42,.12)",
        border:"1px solid "+C.border, background:C.card,
      }}>
        {/* Brand panel */}
        <div className="dh-auth-brand" style={{
          background:`linear-gradient(160deg, ${C.sidebar} 0%, #16222f 100%)`,
          padding:"44px 36px", position:"relative", overflow:"hidden",
          display:"flex", flexDirection:"column", justifyContent:"center",
        }}>
          <div aria-hidden="true" style={{position:"absolute", top:-70, right:-60, width:220, height:250,
            background:`radial-gradient(closest-side, ${C.green}33, transparent 70%)`, filter:"blur(8px)"}}/>
          <div aria-hidden="true" style={{position:"absolute", bottom:-60, left:-40, width:190, height:210,
            background:`radial-gradient(closest-side, ${C.green}22, transparent 70%)`, filter:"blur(6px)"}}/>
          <div style={{fontSize:26, fontWeight:700, color:"#fff", fontFamily:F,
            letterSpacing:"-0.025em", lineHeight:1.15, marginBottom:10}}>
            Know it's a deal<br/>before you offer.
          </div>
          <div style={{fontSize:13.5, color:"rgba(255,255,255,.66)", fontFamily:F, lineHeight:1.6, marginBottom:26}}>
            The investment property analyzer that does the research for you.
          </div>
          <div style={{display:"flex", flexDirection:"column", gap:12}}>
            {perks.map(perk => (
              <div key={perk} style={{display:"flex", alignItems:"flex-start", gap:10}}>
                <span style={{width:20, height:20, borderRadius:9999, background:`${C.green}2e`,
                  border:`1px solid ${C.green}66`, color:C.green, flexShrink:0,
                  display:"inline-flex", alignItems:"center", justifyContent:"center", marginTop:1}}>
                  <I.check size={11} stroke={3}/>
                </span>
                <span style={{fontSize:13.5, color:"rgba(255,255,255,.88)", fontFamily:F, lineHeight:1.5}}>{perk}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Form panel */}
        <div style={{padding:"40px 36px", background:C.card}}>
          <h2 style={{margin:"0 0 6px", fontSize:22, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.02em"}}>
            {mode==="signin" ? "Welcome back" : mode==="signup" ? "Create your free account" : "Reset password"}
          </h2>
          <p style={{margin:"0 0 20px", fontSize:13.5, color:C.textSub, fontFamily:F}}>
            {mode==="signin"  ? "Sign in to your DealHive account" :
             mode==="signup"  ? "Free forever. No credit card required." :
             "Enter your email to get a reset link"}
          </p>
          {err && (
            <div style={{display:"flex", gap:8, alignItems:"flex-start",
              background:C.redSubtle, border:"1px solid "+C.redBorder, borderRadius:C.r2,
              padding:"10px 12px", marginBottom:14, fontSize:13, color:C.redDark, fontFamily:F}}>
              <I.alert size={14} stroke={2.2}/><span>{err}</span>
            </div>
          )}
          {msg && (
            <div style={{display:"flex", gap:8, alignItems:"flex-start",
              background:C.greenSubtle, border:"1px solid "+C.greenBorder, borderRadius:C.r2,
              padding:"10px 12px", marginBottom:14, fontSize:13, color:C.greenDark, fontFamily:F}}>
              <I.check size={14} stroke={2.2}/><span>{msg}</span>
            </div>
          )}

          {mode !== "reset" && (
            <>
              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:16}}>
                <button type="button" onClick={googleSignIn} style={socialBtn} aria-label="Continue with Google">
                  <svg width="17" height="17" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.5 6.1 29.5 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.5 6.1 29.5 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.4 0 10.3-2.1 14-5.4l-6.5-5.5c-2.1 1.6-4.7 2.5-7.5 2.5-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.6 39.6 16.3 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4 5.6l6.5 5.5C41.4 35.6 44 30.3 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>
                  <span className="dh-social-label">Google</span>
                </button>
                <button type="button" onClick={()=>comingSoon("Apple")} style={socialBtn} aria-label="Continue with Apple">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16.4 12.9c0-2.5 2-3.7 2.1-3.8-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.7.9-.8 0-2-.9-3.3-.9-1.7 0-3.2 1-4.1 2.5-1.7 3-0.4 7.5 1.3 9.9.8 1.2 1.8 2.5 3.1 2.5 1.2-.1 1.7-.8 3.2-.8s1.9.8 3.3.8c1.3 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.4-2.8-.1-.1-2.7-1.1-2.7-3.9zM13.9 5.4c.7-.8 1.1-1.9 1-3-1 0-2.1.6-2.8 1.5-.6.7-1.2 1.9-1 3 1 .1 2.1-.6 2.8-1.5z"/></svg>
                  <span className="dh-social-label">Apple</span>
                </button>
                <button type="button" onClick={()=>comingSoon("Facebook")} style={socialBtn} aria-label="Continue with Facebook">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="#1877F2"><path d="M24 12a12 12 0 10-13.9 11.9v-8.4h-3V12h3V9.4c0-3 1.8-4.7 4.6-4.7 1.3 0 2.7.2 2.7.2v3h-1.5c-1.5 0-1.9.9-1.9 1.9V12h3.3l-.5 3.5h-2.8v8.4A12 12 0 0024 12z"/></svg>
                  <span className="dh-social-label">Facebook</span>
                </button>
              </div>
              <div style={{display:"flex", alignItems:"center", gap:12, margin:"0 0 16px"}}>
                <span style={{flex:1, height:1, background:C.border}}/>
                <span style={{fontSize:11.5, color:C.textMuted, fontFamily:F, letterSpacing:".04em", textTransform:"uppercase"}}>or with email</span>
                <span style={{flex:1, height:1, background:C.border}}/>
              </div>
            </>
          )}

          <form onSubmit={submit}>
            <div style={{marginBottom:14}}>
              <label style={{fontSize:13, color:C.text, fontWeight:500, display:"block", marginBottom:6, fontFamily:F}}>Email</label>
              <input type="email" value={email} onChange={e=>setEmail(e.target.value)} required
                placeholder="you@example.com" style={iS()} />
            </div>
            {mode !== "reset" && (
              <div style={{marginBottom:14}}>
                <div style={{display:"flex", justifyContent:"space-between", marginBottom:6}}>
                  <label style={{fontSize:13, color:C.text, fontWeight:500, fontFamily:F}}>Password</label>
                  {mode === "signin" && (
                    <button type="button" onClick={()=>{setMode("reset");setErr("");}} style={{...linkBtn, fontSize:12}}>
                      Forgot?
                    </button>
                  )}
                </div>
                <input type="password" value={password} onChange={e=>setPass(e.target.value)} required
                  placeholder="At least 6 characters" style={iS()} />
              </div>
            )}
            {mode === "signup" && (
              <div style={{marginBottom:14}}>
                <label style={{fontSize:13, color:C.text, fontWeight:500, display:"block", marginBottom:6, fontFamily:F}}>Confirm password</label>
                <input type="password" value={confirm} onChange={e=>setConf(e.target.value)} required
                  placeholder="Repeat your password" style={iS()} />
              </div>
            )}
            <button type="submit" disabled={loading}
              {...btnStyle("primary","lg", {width:"100%", marginTop:6, marginBottom:14, justifyContent:"center"})}>
              {loading ? "Please wait..." :
               mode==="signin"  ? "Sign in" :
               mode==="signup"  ? <>Create free account <I.arrowRight size={14}/></> :
               "Send reset email"}
            </button>
          </form>
          <div style={{textAlign:"center", fontSize:13, color:C.textSub, fontFamily:F}}>
            {mode==="signin" ? (
              <>Don't have an account? <button onClick={()=>{setMode("signup");setErr("");}} style={linkBtn}>Sign up free</button></>
            ) : mode==="signup" ? (
              <>Already have an account? <button onClick={()=>{setMode("signin");setErr("");}} style={linkBtn}>Sign in</button></>
            ) : (
              <button onClick={()=>{setMode("signin");setErr("");}} style={{...linkBtn, display:"inline-flex", alignItems:"center", gap:4}}>
                <I.arrowLeft size={13}/> Back to sign in
              </button>
            )}
          </div>
        </div>
      </div>
      <style>{`
        @media (max-width: 860px) {
          .dh-auth-grid { grid-template-columns: 1fr !important; max-width: 460px !important; }
          .dh-auth-brand { padding: 30px 26px !important; }
        }
        @media (max-width: 420px) {
          .dh-social-label { display: none; }
        }
      `}</style>
    </div>
  );
}

function MapView({properties, onSelect}) {
  const ref=useRef(null), inst=useRef(null), markers=useRef([]);
  useEffect(() => {
    if (inst.current || !window.L) return;
    const map = window.L.map(ref.current, {zoomControl:true}).setView([41.49,-81.69], 11);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {attribution:"(c) OpenStreetMap"}).addTo(map);
    inst.current = map;
  }, []);
  useEffect(() => {
    const L = window.L, map = inst.current;
    if (!L || !map) return;
    markers.current.forEach(m => m.remove());
    markers.current = [];
    window.__dhOpen = id => onSelect(id);
    properties.forEach(p => {
      if (!p.lat || !p.lng) return;
      const isOcc = p.occupied;
      const dotColor = isOcc ? "#10b981" : "#71717a";
      const icon = L.divIcon({className:"", iconSize:[28,28], iconAnchor:[14,14],
        html:'<div style="width:28px;height:28px;background:'+dotColor+';border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(9,9,11,.25),0 0 0 1px rgba(9,9,11,.1)"></div>'});
      const cf = calc(p).chosenCF;
      const cfStr = (cf<0?"-$":"$")+Math.abs(Math.round(cf)).toLocaleString()+"/mo";
      const cfClr = cf>0 ? "#059669" : cf<0 ? "#dc2626" : "#71717a";
      const popup = '<div style="font-family:Inter,system-ui,sans-serif;min-width:180px;font-size:13px;padding:4px">'+
        '<div style="font-weight:600;color:#09090b;letter-spacing:-.01em;margin-bottom:2px">'+p.address+'</div>'+
        '<div style="font-size:12px;color:#52525b;margin-bottom:8px">'+(p.city||"")+', '+(p.state||"")+'</div>'+
        '<div style="font-size:18px;font-weight:700;color:'+cfClr+';letter-spacing:-.01em;margin-bottom:10px;font-variant-numeric:tabular-nums">'+cfStr+'</div>'+
        '<button onclick="window.__dhOpen(\''+p.id+'\')" style="background:#10b981;color:#fff;border:none;padding:7px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;width:100%;font-family:inherit;letter-spacing:-.005em">Open property</button>'+
        '</div>';
      markers.current.push(L.marker([p.lat,p.lng],{icon}).addTo(map).bindPopup(popup));
    });
  }, [properties, onSelect]);
  return <div ref={ref} style={{height:"100%", width:"100%"}} />;
}

// -- Appreciation Projector ----------------------------------------------------
function AppreciationProjector({homeValue, purchasePrice, mobile}) {
  const [rate, setRate] = useState(3);
  if (!homeValue && !purchasePrice) return null;
  const base = homeValue || purchasePrice;
  const years = [1,3,5,10,20];
  return (
    <SectionBlock title="Appreciation Projector" color={C.green} collapsible defaultOpen={true}>
      <div style={{marginBottom:16}}>
        <div style={{display:"flex", justifyContent:"space-between", marginBottom:8}}>
          <label style={{fontSize:13, color:C.text, fontWeight:500, fontFamily:F}}>Annual appreciation</label>
          <span style={{fontSize:13, fontWeight:600, color:C.green, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>{rate}%</span>
        </div>
        <input type="range" min={0} max={10} step={0.5} value={rate}
          onChange={e=>setRate(parseFloat(e.target.value))}
          style={{width:"100%", accentColor:C.green}} />
        <div style={{display:"flex", justifyContent:"space-between", fontSize:11, color:C.textMuted, fontFamily:F, marginTop:6, fontVariantNumeric:"tabular-nums"}}>
          <span>0%</span><span>5%</span><span>10%</span>
        </div>
      </div>
      <div style={{display:"grid", gridTemplateColumns:mobile?"1fr 1fr":"repeat(5,1fr)", gap:1,
        background:C.border, borderRadius:C.r3, overflow:"hidden", border:"1px solid "+C.border}}>
        {years.map(yr => {
          const val = base * Math.pow(1 + rate/100, yr);
          const gain = val - base;
          return (
            <div key={yr} style={{background:C.card, padding:"12px 10px", textAlign:"center"}}>
              <div style={{fontSize:11, color:C.textMuted, fontFamily:F, fontWeight:500, letterSpacing:".03em", textTransform:"uppercase"}}>{yr} yr{yr>1?"s":""}</div>
              <div style={{fontSize:14, fontWeight:700, color:C.text, fontFamily:F, marginTop:4, fontVariantNumeric:"tabular-nums", letterSpacing:"-0.01em"}}>{$(val)}</div>
              <div style={{fontSize:11, color:C.greenDark, fontFamily:F, marginTop:2, fontWeight:500, fontVariantNumeric:"tabular-nums"}}>+{$(gain)}</div>
            </div>
          );
        })}
      </div>
      <div style={{marginTop:12, fontSize:12, color:C.textMuted, fontFamily:F, lineHeight:1.5}}>
        Based on a current value of {$(base)}. Appreciation is not guaranteed.
      </div>
    </SectionBlock>
  );
}

// -- Itemize sheet ---------------------------------------------------------------
// Itemized breakdown editor for closing costs or repair costs. Items support
// $ amounts, % of purchase price, % of loan amount, and roll-into-loan. Rows
// re-order via the drag handle (desktop) or Move Up/Down in the edit panel.
const CLOSING_PREFILL = () => [
  {id:"ci1", name:"Home Inspection",     type:"amount",   value:0, rollIn:false},
  {id:"ci2", name:"Appraisal",           type:"amount",   value:0, rollIn:false},
  {id:"ci3", name:"Loan Points",         type:"pct_loan", value:0, rollIn:true},
  {id:"ci4", name:"Lender Fees",         type:"amount",   value:0, rollIn:false},
  {id:"ci5", name:"Title & Escrow Fees", type:"amount",   value:0, rollIn:false},
  {id:"ci6", name:"Transfer Taxes",      type:"amount",   value:0, rollIn:false},
  {id:"ci7", name:"Attorney Fees",       type:"amount",   value:0, rollIn:false},
  {id:"ci8", name:"Wholesaler Fee",      type:"amount",   value:0, rollIn:false},
];
const REPAIR_PREFILL = () => [
  {id:"ri1",  name:"Kitchen",            type:"amount", value:8000, rollIn:false},
  {id:"ri2",  name:"Bathrooms",          type:"amount", value:5000, rollIn:false},
  {id:"ri3",  name:"Flooring",           type:"amount", value:4000, rollIn:false},
  {id:"ri4",  name:"Interior Paint",     type:"amount", value:3000, rollIn:false},
  {id:"ri5",  name:"Roof",               type:"amount", value:0,    rollIn:false},
  {id:"ri6",  name:"HVAC",               type:"amount", value:0,    rollIn:false},
  {id:"ri7",  name:"Electrical",         type:"amount", value:0,    rollIn:false},
  {id:"ri8",  name:"Plumbing",           type:"amount", value:0,    rollIn:false},
  {id:"ri9",  name:"Windows & Doors",    type:"amount", value:0,    rollIn:false},
  {id:"ri10", name:"Landscaping",        type:"amount", value:1000, rollIn:false},
  {id:"ri11", name:"Permits & Fees",     type:"amount", value:500,  rollIn:false},
  {id:"ri12", name:"Contingency",        type:"pct_price", value:3, rollIn:false},
];
const ITEM_TYPE_LABELS = {
  amount:    "Set Amount",
  pct_price: "% of Purchase Price",
  pct_loan:  "% of Loan Amount",
};

function ItemizeSheet({title, items: initialItems, prefill, onApply, onClose, price = 0, loanAmt = 0, mobile,
                       typeOptions = null, computeValue = null, allowRollIn = true, perMonth = false}) {
  const [items, setItems] = useState(() =>
    Array.isArray(initialItems) && initialItems.length ? initialItems.map(x => ({...x})) : prefill());
  const [editingId, setEditingId] = useState(null);
  // Pointer-based drag & drop: works for touch and mouse alike. The grip
  // starts a drag; as the pointer crosses other rows' midpoints the list
  // reorders live under the finger.
  const [dragId, setDragId] = useState(null);
  const dragIdRef = useRef(null);

  const dragMove = e => {
    const id = dragIdRef.current;
    if (!id) return;
    const els = document.elementsFromPoint(e.clientX, e.clientY);
    const rowEl = els.find(el => el.dataset && el.dataset.dhItem && el.dataset.dhItem !== id);
    if (!rowEl) return;
    const overId = rowEl.dataset.dhItem;
    const rect = rowEl.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    setItems(list => {
      const from = list.findIndex(x => x.id === id);
      let to = list.findIndex(x => x.id === overId);
      if (from < 0 || to < 0) return list;
      if (after) to += 1;
      if (to > from) to -= 1;            // account for removal shift
      if (to === from) return list;
      const next = [...list];
      const [row] = next.splice(from, 1);
      next.splice(to, 0, row);
      return next;
    });
  };
  const dragEnd = () => {
    dragIdRef.current = null;
    setDragId(null);
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", dragMove);
    window.removeEventListener("pointerup", dragEnd);
    window.removeEventListener("pointercancel", dragEnd);
  };
  const dragStart = (e, id) => {
    e.preventDefault();
    dragIdRef.current = id;
    setDragId(id);
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", dragMove);
    window.addEventListener("pointerup", dragEnd);
    window.addEventListener("pointercancel", dragEnd);
  };
  useEffect(() => () => dragEnd(), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    lockBodyScroll();
    const handler = e => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", handler, true);
    return () => {
      unlockBodyScroll();
      window.removeEventListener("keydown", handler, true);
    };
  }, [onClose]);

  const types = typeOptions || [
    {value:"amount",    label:"Set Amount",           input:"$"},
    {value:"pct_price", label:"% of Purchase Price",  input:"%"},
    {value:"pct_loan",  label:"% of Loan Amount",     input:"%"},
  ];
  const typeOf  = v => types.find(t => t.value === v) || types[0];
  const calcVal = it => computeValue ? computeValue(it) : itemValue(it, price, loanAmt);
  const totals = (() => {
    let upFront = 0, rolled = 0;
    items.forEach(it => { const v = calcVal(it); if (allowRollIn && it.rollIn) rolled += v; else upFront += v; });
    return {upFront, rolled, total: upFront + rolled};
  })();
  const update = (id, patch) => setItems(list => list.map(x => x.id === id ? {...x, ...patch} : x));
  const remove = id => { setItems(list => list.filter(x => x.id !== id)); if (editingId === id) setEditingId(null); };
  const addItem = () => {
    const it = {id:"c"+Date.now(), name:"New Item", type:"amount", value:0, rollIn:false};
    setItems(list => [...list, it]);
    setEditingId(it.id);
  };


  const outerStyle = mobile
    ? {position:"fixed", inset:0, background:"rgba(9,9,11,.6)", zIndex:600,
       display:"flex", alignItems:"flex-end", backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)"}
    : {position:"fixed", inset:0, background:"rgba(9,9,11,.55)", zIndex:600,
       display:"flex", alignItems:"center", justifyContent:"center", padding:20,
       backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)"};
  const innerStyle = mobile
    ? {background:C.card, borderRadius:"18px 18px 0 0", width:"100%", maxHeight:"92dvh",
       overflowY:"auto", overscrollBehavior:"contain", boxShadow:C.sh4, padding:"20px 16px 30px", WebkitOverflowScrolling:"touch"}
    : {background:C.card, borderRadius:C.r5, width:"100%", maxWidth:560, maxHeight:"90dvh",
       overflowY:"auto", overscrollBehavior:"contain", boxShadow:C.sh4, border:"1px solid "+C.border, padding:"22px 22px 24px"};

  return (
    <div style={outerStyle} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={innerStyle}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", gap:12, marginBottom:14}}>
          <div style={{fontSize:18, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.015em"}}>{title}</div>
          <button onClick={onClose} aria-label="Close"
            style={{width:32, height:32, borderRadius:"50%", background:C.bgSubtle, border:"none",
              cursor:"pointer", color:C.textSub, display:"flex", alignItems:"center", justifyContent:"center"}}>
            <I.x size={15}/>
          </button>
        </div>

        <div style={{display:"flex", flexDirection:"column", gap:8}}>
          {items.map(it => {
            const v = calcVal(it);
            const editing = editingId === it.id;
            return (
              <div key={it.id} data-dh-item={it.id}
                style={{border:"1.5px solid "+(dragId === it.id ? C.green : editing ? C.greenBorder : C.border),
                  borderRadius:C.r3,
                  background: dragId === it.id ? "#fff" : editing ? C.greenSubtle : C.card,
                  overflow:"hidden",
                  boxShadow: dragId === it.id ? C.sh4 : "none",
                  transform: dragId === it.id ? "scale(1.015)" : "none",
                  opacity: dragId && dragId !== it.id ? .75 : 1,
                  position: dragId === it.id ? "relative" : "static",
                  zIndex: dragId === it.id ? 2 : "auto",
                  transition:"box-shadow .15s, transform .15s, border-color .15s, opacity .15s"}}>
                <div style={{display:"flex", alignItems:"center", gap:10, padding:"10px 12px"}}>
                  <span title="Drag to re-arrange" aria-label="Drag to re-arrange"
                    onPointerDown={editing ? undefined : e => dragStart(e, it.id)}
                    style={{color: dragId === it.id ? C.greenDark : C.textMuted,
                      cursor: dragId === it.id ? "grabbing" : "grab", flexShrink:0,
                      display:"inline-flex", alignItems:"center", justifyContent:"center",
                      width:32, height:32, margin:"-6px -4px -6px -8px", borderRadius:C.r1,
                      touchAction:"none"}}>
                    <I.menu size={16}/>
                  </span>
                  <div style={{minWidth:0, flex:1}}>
                    <div style={{fontSize:13.5, fontWeight:600, color:C.text, fontFamily:F,
                      overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{it.name}</div>
                    <div style={{fontSize:11.5, color:C.textSub, fontFamily:F, marginTop:1}}>
                      {typeOf(it.type).label}
                      {typeOf(it.type).input === "%" && ` (${it.value || 0}%)`}
                      {allowRollIn && it.rollIn ? " · Rolled Into Loan" : ""}
                    </div>
                  </div>
                  <span style={{fontSize:14, fontWeight:700, color:C.text, fontFamily:F,
                    fontVariantNumeric:"tabular-nums", flexShrink:0}}>{$(v)}{perMonth && <span style={{fontSize:10.5, color:C.textMuted, fontWeight:500}}>/mo</span>}</span>
                  <button onClick={()=>setEditingId(editing ? null : it.id)} aria-label="Edit item"
                    style={{width:30, height:30, borderRadius:C.r1, background:"transparent",
                      border:"1px solid "+C.border, cursor:"pointer", color:C.textSub,
                      display:"inline-flex", alignItems:"center", justifyContent:"center", flexShrink:0}}>
                    <I.edit size={13}/>
                  </button>
                  <button onClick={()=>remove(it.id)} aria-label="Delete item"
                    style={{width:30, height:30, borderRadius:C.r1, background:"transparent",
                      border:"1px solid "+C.border, cursor:"pointer", color:C.redDark,
                      display:"inline-flex", alignItems:"center", justifyContent:"center", flexShrink:0}}>
                    <I.trash size={13}/>
                  </button>
                </div>
                {editing && (
                  <div style={{padding:"12px 12px 14px", borderTop:"1px solid "+C.greenBorder, background:C.card}}>
                    <div style={{display:"grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap:10}}>
                      <div>
                        <label style={{fontSize:12, color:C.textSub, fontFamily:F, display:"block", marginBottom:5, fontWeight:500}}>Name</label>
                        <input value={it.name} onChange={e=>update(it.id, {name:e.target.value})} style={iS(mobile)}/>
                      </div>
                      <div>
                        <label style={{fontSize:12, color:C.textSub, fontFamily:F, display:"block", marginBottom:5, fontWeight:500}}>Type</label>
                        <select value={it.type} onChange={e=>update(it.id, {type:e.target.value})} style={iS(mobile)}>
                          {types.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <label style={{fontSize:12, color:C.textSub, fontFamily:F, display:"block", marginBottom:5, fontWeight:500}}>
                          {typeOf(it.type).input === "%" ? "Percent (%)" : "Amount ($)"}
                        </label>
                        <input type="number" value={it.value || ""} placeholder="0"
                          onChange={e=>update(it.id, {value: parseFloat(e.target.value) || 0})} style={iS(mobile)}/>
                      </div>
                      {allowRollIn && (
                      <div>
                        <label style={{fontSize:12, color:C.textSub, fontFamily:F, display:"block", marginBottom:5, fontWeight:500}}>Roll Into Loan?</label>
                        <div style={{display:"flex", padding:3, background:C.bgSubtle, border:"1px solid "+C.border, borderRadius:C.r2}}>
                          {[[false,"No"],[true,"Yes"]].map(([val,l]) => (
                            <button key={l} onClick={()=>update(it.id, {rollIn:val})}
                              style={{flex:1, padding:"6px 10px", borderRadius:C.r1, border:"none", cursor:"pointer",
                                background: it.rollIn === val ? C.card : "transparent",
                                color: it.rollIn === val ? C.text : C.textSub,
                                fontWeight: it.rollIn === val ? 600 : 500, fontSize:12.5, fontFamily:F,
                                boxShadow: it.rollIn === val ? C.sh1 : "none"}}>{l}</button>
                          ))}
                        </div>
                      </div>
                      )}
                    </div>
                    <div style={{display:"flex", marginTop:12}}>
                      <button onClick={()=>setEditingId(null)} {...btnStyle("primary","sm", {marginLeft:"auto"})}>Done</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <button onClick={addItem} {...btnStyle("secondary","md", {width:"100%", justifyContent:"center", marginTop:12})}>
          <I.plus size={14}/> Add Item
        </button>

        <div style={{marginTop:16, border:"1px solid "+C.border, borderRadius:C.r3, padding:"12px 14px", background:C.bgSubtle}}>
          {allowRollIn && (
            <>
              <div style={{display:"flex", justifyContent:"space-between", fontSize:13, fontFamily:F, color:C.textSub, marginBottom:4}}>
                <span>Paid Up Front</span><span style={{fontVariantNumeric:"tabular-nums"}}>{$(totals.upFront)}</span>
              </div>
              <div style={{display:"flex", justifyContent:"space-between", fontSize:13, fontFamily:F, color:C.textSub, marginBottom:6}}>
                <span>Rolled Into Loan</span><span style={{fontVariantNumeric:"tabular-nums"}}>{$(totals.rolled)}</span>
              </div>
            </>
          )}
          <div style={{display:"flex", justifyContent:"space-between", fontSize:14.5, fontWeight:700, fontFamily:F, color:C.text,
            paddingTop: allowRollIn ? 8 : 0, borderTop: allowRollIn ? "1px solid "+C.border : "none"}}>
            <span>Total{perMonth ? " / mo" : ""}</span><span style={{fontVariantNumeric:"tabular-nums"}}>{$(totals.total)}{perMonth ? "/mo" : ""}</span>
          </div>
        </div>

        <div style={{display:"flex", gap:10, marginTop:16}}>
          <button onClick={onClose} {...btnStyle("secondary","lg", {flex:1, justifyContent:"center"})}>Cancel</button>
          <button onClick={()=>onApply(items, totals)} {...btnStyle("primary","lg", {flex:2, justifyContent:"center"})}>
            <I.check size={14}/> Apply {$(totals.total)}{perMonth ? "/mo" : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

// -- Rent comps sheet ------------------------------------------------------------
// RentCast rent AVM + nearby active rental listings for the entered address,
// so Monthly Rent can be sanity-checked without leaving the analyzer.
function RentCompsSheet({p, apiLookup, rcAuth, tier, onUseRent, onClose, onUpgrade, mobile}) {
  const isPro = tier === "pro";
  const [st, setSt] = useState({loading:true, err:null, rent:0, low:0, high:0, comps:[]});

  useEffect(() => {
    lockBodyScroll();
    const handler = e => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", handler, true);
    return () => {
      unlockBodyScroll();
      window.removeEventListener("keydown", handler, true);
    };
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const q    = encodeURIComponent(`${p.address}, ${p.city}, ${p.state} ${p.zip||""}`.trim());
        const beds = p.beds || 3;
        const avm  = await apiLookup(lookupKey("rc-rentavm", p.address, p.city, p.state, p.zip, beds),
          () => rcGet(`/avm/rent/long-term?address=${q}&bedrooms=${beds}`, rcAuth));
        let comps = [];
        try {
          const listings = await apiLookup(lookupKey("rc-rentcomps-1mi", p.address, p.city, p.state, p.zip, beds),
            () => rcGet(`/listings/rental/long-term?address=${q}&bedrooms=${beds}&radius=1&limit=12&status=Active`, rcAuth));
          comps = Array.isArray(listings) ? listings : [];
          // Nearest first — in comps, proximity is credibility.
          comps = comps.map(l => ({...l,
            _mi: (p.lat != null && p.lng != null && l.latitude != null && l.longitude != null)
              ? milesBetween(p.lat, p.lng, l.latitude, l.longitude) : null}))
            .sort((a, b) => (a._mi ?? 99) - (b._mi ?? 99));
        } catch { /* comps are a bonus — the estimate alone is still useful */ }
        if (!alive) return;
        const rent = avm?.rent || 0;
        setSt({
          loading:false,
          err: rent ? null : "No rent estimate found for that address.",
          rent,
          low:  avm?.rentRangeLow  || (rent ? Math.round(rent*0.9) : 0),
          high: avm?.rentRangeHigh || (rent ? Math.round(rent*1.1) : 0),
          comps,
        });
      } catch (e) {
        if (!alive) return;
        setSt(x => ({...x, loading:false,
          err: e && e.code === "CAP" ? LOOKUP_CAP_MSG : "Rent lookup failed. Check the address and try again."}));
      }
    })();
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const outerStyle = mobile
    ? {position:"fixed", inset:0, background:C.card, zIndex:600}
    : {position:"fixed", inset:0, background:"rgba(9,9,11,.55)", zIndex:600,
       display:"flex", alignItems:"center", justifyContent:"center", padding:20,
       backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)"};
  const innerStyle = mobile
    ? {background:C.card, width:"100%", height:"100%", overflowY:"auto", overscrollBehavior:"contain",
       padding:"calc(16px + env(safe-area-inset-top, 0px)) 16px 40px", WebkitOverflowScrolling:"touch"}
    : {background:C.card, borderRadius:C.r5, width:"100%", maxWidth:520, maxHeight:"88dvh",
       overflowY:"auto", overscrollBehavior:"contain", boxShadow:C.sh4, border:"1px solid "+C.border, padding:"22px 22px 24px"};

  return (
    <div style={outerStyle} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={innerStyle}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12, marginBottom:14}}>
          <div style={{minWidth:0}}>
            <div style={{fontSize:18, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.015em"}}>Rental Comps</div>
            <div style={{fontSize:12.5, color:C.textSub, fontFamily:F, marginTop:2,
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
              {p.address}{p.city ? `, ${p.city}` : ""}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{width:32, height:32, borderRadius:"50%", background:C.bgSubtle, border:"none",
              cursor:"pointer", color:C.textSub, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0}}>
            <I.x size={15}/>
          </button>
        </div>

        {st.loading ? (
          <div style={{padding:"36px 0", textAlign:"center", color:C.textSub, fontSize:13.5, fontFamily:F}}>
            Pulling market rents…
          </div>
        ) : st.err ? (
          <div style={{display:"flex", gap:8, alignItems:"flex-start", background:C.redSubtle,
            border:"1px solid "+C.redBorder, borderRadius:C.r2, padding:"12px 14px",
            fontSize:13, color:C.redDark, fontFamily:F, lineHeight:1.55}}>
            <I.alert size={15} style={{flexShrink:0, marginTop:1}}/> {st.err}
          </div>
        ) : (
          <>
            <div style={{
              background:`linear-gradient(150deg, ${C.greenSubtle} 0%, #fff 80%)`,
              border:"1px solid "+C.greenBorder, borderRadius:C.r4,
              padding:"18px 16px", textAlign:"center", boxShadow:C.sh2,
            }}>
              <div style={{fontSize:10.5, fontWeight:700, color:C.greenDark, fontFamily:F,
                letterSpacing:".07em", textTransform:"uppercase"}}>Market Rent Estimate</div>
              <div style={{fontSize:34, fontWeight:800, color:C.text, fontFamily:F,
                fontVariantNumeric:"tabular-nums", letterSpacing:"-0.03em", marginTop:3}}>
                {$(st.rent)}<span style={{fontSize:15, color:C.textSub, fontWeight:500}}>/mo</span>
              </div>
              <div style={{display:"inline-flex", alignItems:"center", gap:6, marginTop:6,
                background:"#fff", border:"1px solid "+C.border, borderRadius:9999,
                padding:"4px 12px", fontSize:12, color:C.textSub, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>
                Range {$(st.low)} – {$(st.high)}
              </div>
              {onUseRent && (
                <button onClick={()=>onUseRent(st.rent, st.low, st.high)}
                  {...btnStyle("primary","lg", {marginTop:14, justifyContent:"center", width:"100%"})}>
                  <I.check size={14}/> Use {$(st.rent)}/mo as Monthly Rent
                </button>
              )}
            </div>

            {st.comps.length > 0 && (() => {
              const visible = isPro ? st.comps : st.comps.slice(0, 5);
              const hidden  = st.comps.length - visible.length;
              // Two of the locked comps render blurred behind the unlock CTA,
              // so free users see exactly what Pro is holding for them.
              const teaser  = hidden > 0 ? st.comps.slice(5, 7) : [];
              const listedOn = l => {
                const d = l.listedDate || l.createdDate || l.lastSeenDate;
                if (!d) return null;
                const dt = new Date(d);
                return isNaN(dt.getTime())
                  ? null
                  : dt.toLocaleDateString("en-US", {month:"short", day:"numeric"});
              };
              const row = (l, i) => {
                const rentV = l.price || l.rent || 0;
                const psf   = l.squareFootage ? (rentV / l.squareFootage) : null;
                const seen  = listedOn(l);
                return (
                  <div key={l.id || i} style={{
                    display:"flex", justifyContent:"space-between", alignItems:"center", gap:12,
                    border:"1px solid "+C.border, borderRadius:C.r3, padding:"12px 13px",
                    background:"linear-gradient(180deg, #fff 0%, #fcfcfd 100%)", boxShadow:C.sh1,
                  }}>
                    <div style={{display:"flex", alignItems:"flex-start", gap:11, minWidth:0}}>
                      <span style={{
                        width:30, height:30, borderRadius:8, flexShrink:0, marginTop:1,
                        background:C.greenSubtle, border:"1px solid "+C.greenBorder, color:C.greenDark,
                        display:"inline-flex", alignItems:"center", justifyContent:"center",
                        fontSize:11.5, fontWeight:800, fontFamily:F,
                      }}>{i+1}</span>
                      <div style={{minWidth:0}}>
                        <div style={{fontSize:13, fontWeight:650, color:C.text, fontFamily:F,
                          lineHeight:1.35, letterSpacing:"-0.005em"}}>
                          {l.formattedAddress || l.addressLine1 || "Nearby rental"}
                        </div>
                        <div style={{fontSize:11.5, color:C.textSub, fontFamily:F, marginTop:2}}>
                          {(l.bedrooms||0)}bd · {(l.bathrooms||0)}ba{l.squareFootage ? ` · ${l.squareFootage.toLocaleString()} sqft` : ""}
                        </div>
                      </div>
                    </div>
                    <div style={{textAlign:"right", flexShrink:0}}>
                      <div style={{fontSize:15, fontWeight:700, color:C.text, fontFamily:F,
                        fontVariantNumeric:"tabular-nums", letterSpacing:"-0.01em"}}>
                        {$(rentV)}<span style={{fontSize:11, color:C.textSub, fontWeight:500}}>/mo</span>
                      </div>
                      {psf && (
                        <div style={{fontSize:10.5, color:C.textMuted, fontFamily:F, fontVariantNumeric:"tabular-nums", marginTop:1}}>
                          ${psf.toFixed(2)}/sqft
                        </div>
                      )}
                      {(seen || l._mi != null) && (
                        <div style={{display:"inline-flex", alignItems:"center", marginTop:4,
                          padding:"2px 8px", borderRadius:9999, background:C.bgSubtle,
                          border:"1px solid "+C.border, fontSize:10, fontWeight:600,
                          color:C.textSub, fontFamily:F, whiteSpace:"nowrap"}}>
                          {[l._mi != null ? `${l._mi.toFixed(2)} mi` : null,
                            seen ? `Listed ${seen}` : null].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                  </div>
                );
              };
              return (
              <>
                <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline",
                  margin:"20px 0 10px"}}>
                  <span style={{fontSize:11, fontWeight:700, color:C.textSub, fontFamily:F,
                    letterSpacing:".06em", textTransform:"uppercase"}}>
                    Active Rentals Within 1 Mi
                  </span>
                  <span style={{fontSize:11.5, color:C.textMuted, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>
                    {isPro ? st.comps.length : `showing ${visible.length} of ${st.comps.length}`}
                  </span>
                </div>
                <div style={{display:"flex", flexDirection:"column", gap:8}}>
                  {visible.map(row)}
                </div>
                {hidden > 0 && (
                  <div style={{position:"relative", marginTop:8, borderRadius:C.r4, overflow:"hidden"}}>
                    <div aria-hidden="true" style={{display:"flex", flexDirection:"column", gap:8,
                      filter:"blur(6px)", opacity:.8, pointerEvents:"none", userSelect:"none"}}>
                      {teaser.map((l, i) => row(l, i + 5))}
                    </div>
                    <div style={{position:"absolute", inset:0, display:"flex", flexDirection:"column",
                      alignItems:"center", justifyContent:"center", gap:10, padding:"0 16px",
                      background:"linear-gradient(180deg, rgba(255,255,255,.5) 0%, rgba(255,255,255,.94) 100%)"}}>
                      <div style={{display:"inline-flex", alignItems:"center", gap:8,
                        fontSize:13.5, fontWeight:800, color:C.text, fontFamily:F, letterSpacing:"-0.01em"}}>
                        <span style={{width:26, height:26, borderRadius:"50%", flexShrink:0,
                          background:C.greenSubtle, border:"1px solid "+C.greenBorder, color:C.greenDark,
                          display:"inline-flex", alignItems:"center", justifyContent:"center"}}>
                          <I.lock size={12} stroke={2.6}/>
                        </span>
                        {hidden} more comp{hidden===1?"":"s"} within a mile
                      </div>
                      {onUpgrade ? (
                        <button onClick={onUpgrade} {...btnStyle("primary","md")}>
                          <I.star size={13}/> Unlock with Pro
                        </button>
                      ) : (
                        <div style={{fontSize:12, color:C.textSub, fontFamily:F}}>
                          Upgrade to Pro in Settings to see them all.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}

// Shared Summary block — rendered in the calculator grid normally, but the
// analyzer relocates it to sit right above Notes on the Cash tab.
function DealSummaryBlock({p, m, exit}) {
  const cash = (p.chosenStrategy||"finance") === "cash";
  const exitLabel = exit === "brrrr" ? "BRRRR"
    : exit === "flip" ? "Fix & Flip"
    : m.owned ? "Rental"
    : cash ? "Buy & Hold" : "Rental";
  // Rows adapt to the exit: a flip is sold (profit + return on cash, no cap
  // rate or monthly cash flow); a BRRRR's story is the refi proceeds and the
  // post-refi cash flow; a hold shows the rental metrics.
  let rows;
  if (exit === "flip") {
    const profit  = cash ? m.flipProfit : m.finFlipProfit;
    const roi     = cash ? m.flipROI    : m.finFlipROI;
    const holding = cash ? m.flipHolding : m.finFlipHolding;
    rows = [
      ["Sale Price (ARV)", $(p.flipSalePrice||0), C.text],
      ["Agent Fee", $(m.agentFee), C.text],
      [`Holding Costs (${m.holdMonths} mo)`, $(holding), C.text],
      ...(m.owned && m.ownedBal > 0 ? [["Loan Payoff at Sale", $(m.ownedBal), C.text]]
        : cash ? [] : [["Loan Payoff at Sale", $(m.loan), C.text]]),
      ["hr"],
      [m.owned ? "New Cash In (Rehab)" : "Out of Pocket", $(m.chosenOOP), C.text],
      [m.owned ? "Net Cash From Sale" : "Total Profit",  $(profit),      cfC(profit)],
      [m.owned ? "Return on New Cash" : "Cash-on-Cash",  pct(roi),       cfC(profit)],
    ];
  } else if (exit === "brrrr") {
    const refiCash = (cash && !m.owned) ? m.brrrCashNet : m.brrrNetCash;
    const allIn    = m.chosenOOP + m.brrrHolding;
    // Cash that actually ends up in your pocket: net refi proceeds beyond
    // everything invested, including the rehab-months holding costs.
    const inPocket = Math.max(Math.max(refiCash, 0) - allIn, 0);
    rows = [
      [m.owned ? "New Cash In (Rehab)" : "Out of Pocket", $(m.chosenOOP), C.text],
      [`Holding Costs (${m.holdMonths} mo)`, $(m.brrrHolding), C.text],
      ["Total Invested", $(allIn), C.text],
      ["Net Cash at Refi", $(refiCash), cfC(refiCash)],
      ["hr"],
      ["Cash Flow / mo (After Refi)", $mo(m.brrrCF), cfC(m.brrrCF)],
      ["Cash in Pocket", $(inPocket), cfC(inPocket)],
    ];
  } else {
    rows = [
      [m.owned ? "New Cash In (Rehab)" : "Out of Pocket", $(m.chosenOOP), C.text],
      ...(m.owned
        ? (m.ownedPmt > 0 ? [["Current Loan Payment / mo", $mo(m.ownedPmt), C.text]] : [])
        : cash ? [] : [["Loan Payments / mo", $mo(m.mtg), C.text]]),
      ["Net Cash Flow / mo", $mo(m.chosenCF),  cfC(m.chosenCF)],
      ["NOI / yr",           $(m.noi*12),      C.text],
      [m.owned ? "Return on New Cash" : "Cash-on-Cash", pct(m.chosenCoC), cfC(m.chosenCoC)],
      ["Cap Rate",           pct(m.chosenCap), C.text],
    ];
  }
  return (
    <SectionBlock title="Summary" color={C.green} icon={I.clipboardCheck}>
      <DataRow label={m.owned ? "Ownership" : "Purchase Method"}
        value={m.owned ? "Already Owned" : cash ? "Cash" : "Finance"} />
      <DataRow label="Exit Strategy" value={exitLabel} />
      {rows.map(([l, v, color], i) =>
        l === "hr"
          ? <div key={"hr"+i} style={{height:1, background:C.border, margin:"8px 0"}}/>
          : <DataRow key={l} label={l} value={v} color={color} />)}
    </SectionBlock>
  );
}

// -- Calculator ----------------------------------------------------------------
function Calculator({p, set, renoRates={light:7,medium:13,full:45}, mobile, stickyTop, apiLookup, rentcastKey, rcAuth, tier, onUpgrade, exit, onExitChange, externalSummary, midSlot}) {
  const u   = (f,v) => set({...p, [f]:v});
  const m   = calc(p);
  const s   = p.chosenStrategy || "finance";
  const methodChosen = !!p.chosenStrategy;
  const [itemize, setItemize] = useState(null); // null | "brrrr"-less: "closing" | "repair"
  // Exit-strategy toggle can be driven from outside (the analyzer lifts it so
  // the Save button can say what it's saving as); falls back to local state.
  const [localXtra, setLocalXtra] = useState(null); // null | "brrrr" | "flip"
  const xtra    = exit !== undefined ? exit : localXtra;
  const setXtra = onExitChange ?? setLocalXtra;
  const [avmBusy, setAvmBusy] = useState(false);
  const [avmMsg,  setAvmMsg]  = useState(null);  // {kind:"ok"|"err", text}
  const [compsOpen, setCompsOpen] = useState(false);
  // One-time attention pulse on the exit toggle. It only plays once the
  // toggle is actually on screen (a plain timer used to fire while the row
  // was still scrolled out of view, so nobody ever saw it), and it re-arms
  // when the address changes so each new property gets its own pulse.
  const [exitPulse, setExitPulse] = useState(false);
  const [addrNudge, setAddrNudge] = useState(false);
  useEffect(() => { if (p.address) setAddrNudge(false); }, [p.address]);
  const pulsedRef  = useRef(false);
  const exitRowRef = useRef(null);
  useEffect(() => { pulsedRef.current = false; }, [p.address]);
  useEffect(() => {
    if (pulsedRef.current) return;
    if (!methodChosen || !(p.purchasePrice > 0)) return;
    const el = exitRowRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let t1, t2;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || pulsedRef.current) return;
      pulsedRef.current = true;
      io.disconnect();
      t1 = setTimeout(() => setExitPulse(true), 250);
      t2 = setTimeout(() => setExitPulse(false), 3250);
    }, {threshold: 0.6});
    io.observe(el);
    return () => { io.disconnect(); clearTimeout(t1); clearTimeout(t2); };
  }, [methodChosen, p.purchasePrice, p.address]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Check Home Value" — RentCast value AVM for the entered address. Fills the
  // ARV field (high end of the range) and keeps the median for reference.
  const checkHomeValue = async () => {
    if (!p.address || !p.city || !p.state) { setAvmMsg({kind:"err", text:"Enter the property address first."}); return; }
    if (!rcOk(rcAuth) || !apiLookup) { setAvmMsg({kind:"err", text:"Live home values are currently unavailable."}); return; }
    setAvmBusy(true); setAvmMsg(null);
    try {
      const q   = encodeURIComponent(`${p.address}, ${p.city}, ${p.state} ${p.zip||""}`.trim());
      const key = lookupKey("rc-value", p.address, p.city, p.state, p.zip);
      const val = await apiLookup(key, () => rcGet(`/avm/value?address=${q}`, rcAuth));
      const med = val?.price || 0;
      const hi  = val?.priceRangeHigh || (med ? Math.round(med * 1.1) : 0);
      const lo  = val?.priceRangeLow  || (med ? Math.round(med * 0.9) : 0);
      if (!med && !hi) { setAvmMsg({kind:"err", text:"No value estimate found for that address."}); }
      else {
        set({...p, homeValueMedian: med, homeValueLow: lo, homeValueHigh: med,
          flipSalePrice: med, brrrCashOut: Math.round(med * 0.75)});
        setAvmMsg({kind:"ok", med, lo, hi});
      }
    } catch (e) {
      setAvmMsg({kind:"err", text: e && e.code === "CAP" ? LOOKUP_CAP_MSG : "Value lookup failed. Check the address and try again."});
    }
    setAvmBusy(false);
  };

  // Auto-fill monthly property tax from the state's effective rate — every
  // state, not just Ohio. Basis is the assessed/market tax value when a data
  // pull provided one, else the purchase price. A manual edit to the field
  // (expPropTaxAuto === false) or a pulled tax record turns the sync off.
  useEffect(() => {
    if (Array.isArray(p.expenseItems) && p.expenseItems.length) return;
    const basis = (p.taxValue||0) > 0 ? p.taxValue : (p.purchasePrice||0);
    if (basis <= 0) return;
    const next = {};
    if (p.expPropTaxAuto !== false) {
      const rate = STATE_TAX_RATES[(p.state||"").toUpperCase()] || DEFAULT_TAX_RATE;
      const monthly = Math.round(basis * rate / 12);
      if (p.expPropTax !== monthly) next.expPropTax = monthly;
    }
    if (p.expInsuranceAuto !== false && !(p.expInsurance > 0)) {
      const insRate = INSURANCE_RATES[(p.state||"").toUpperCase()] || DEFAULT_INS_RATE;
      next.expInsurance = Math.round((p.homeValueMedian || basis) * insRate / 12);
    }
    if (Object.keys(next).length) set({...p, ...next});
  }, [p.state, p.taxValue, p.purchasePrice, p.homeValueMedian, p.expPropTaxAuto, p.expInsuranceAuto]); // eslint-disable-line react-hooks/exhaustive-deps

  // Owned mode: the price field holds today's value, so seed it from the
  // pulled value estimate (or tax value) rather than making the user type it.
  useEffect(() => {
    if (!p.alreadyOwned || (p.purchasePrice||0) > 0) return;
    const v = p.homeValueMedian || p.taxValue || 0;
    if (v > 0) set({...p, purchasePrice: v});
  }, [p.alreadyOwned, p.homeValueMedian, p.taxValue]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      {/* Purchase method — chosen explicitly before the calculator opens */}
      {!methodChosen && (
        <Card style={{padding: mobile ? "22px 18px" : "28px 24px", marginBottom:14, textAlign:"center"}}>
          <div style={{fontSize:17, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.02em"}}>
            How are you buying this property?
          </div>
          <div style={{fontSize:13, color:C.textSub, fontFamily:F, marginTop:4, marginBottom:18}}>
            Pick a purchase method and the calculator opens for it. You can switch anytime.
          </div>
          {addrNudge && (
            <div style={{
              display:"flex", alignItems:"center", justifyContent:"center", gap:9,
              margin:"0 auto 16px", maxWidth:440, padding:"11px 16px",
              background:`linear-gradient(135deg, ${C.greenSubtle} 0%, #fff 85%)`,
              border:"1px solid "+C.greenBorder, borderRadius:C.r3,
              fontSize:13.5, fontWeight:600, color:C.greenDark, fontFamily:F,
              animation:"dhNudge .4s ease",
            }}>
              <I.pin size={15} stroke={2.2}/> Enter the property address above first — the analysis starts there.
            </div>
          )}
          <div style={{display:"grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap:12, maxWidth:520, margin:"0 auto"}}>
            {[["cash","Cash","All-cash purchase. Simple math, full equity from day one.",C.cashPos],
              ["finance","Finance","Loans, down payments, leverage. Model it like real life.",C.green]].map(([id,label,line,accent]) => (
              <button key={id}
                onClick={()=>{ if (!p.address) { setAddrNudge(true); return; } set({...p, chosenStrategy:id, alreadyOwned:false}); }}
                style={{
                  padding:"18px 16px", borderRadius:C.r4, cursor:"pointer", textAlign:"center",
                  background:"#fff", border:"1.5px solid "+C.border,
                  transition:"border-color .12s, box-shadow .12s, transform .12s",
                }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor=accent; e.currentTarget.style.boxShadow=C.sh3; e.currentTarget.style.transform="translateY(-1px)";}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border; e.currentTarget.style.boxShadow="none"; e.currentTarget.style.transform="none";}}>
                <span style={{
                  display:"inline-flex", alignItems:"center", justifyContent:"center",
                  width:40, height:40, borderRadius:11, marginBottom:9,
                  background:`${accent}1a`, color:accent,
                }}>
                  {id === "cash" ? <I.dollar size={19} stroke={2.2}/> : <I.building size={19} stroke={2.2}/>}
                </span>
                <span style={{display:"block", fontSize:16, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.015em"}}>{label}</span>
                <span style={{display:"block", fontSize:12, color:C.textSub, fontFamily:F, marginTop:3, lineHeight:1.45}}>{line}</span>
              </button>
            ))}
          </div>
          <button
            onClick={()=>{ if (!p.address) { setAddrNudge(true); return; } set({...p, alreadyOwned:true, chosenStrategy:"cash"}); }}
            style={{marginTop:16, display:"inline-flex", alignItems:"center", gap:7,
              padding:"9px 16px", borderRadius:9999, background:"#fff",
              border:"1px dashed "+C.borderHover, color:C.textSub,
              fontSize:13, fontWeight:600, fontFamily:F, cursor:"pointer",
              transition:"border-color .12s, color .12s"}}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=C.blue; e.currentTarget.style.color=C.blueDark;}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor=C.borderHover; e.currentTarget.style.color=C.textSub;}}>
            <I.home size={14} stroke={2.2}/> I already own this property
          </button>
        </Card>
      )}

      {methodChosen && (
      <>
      {/* Strategy tabs — sticky on mobile so the cash/finance switch stays in view */}
      <div style={{fontSize:12, fontWeight:700, color:C.textSub, fontFamily:F,
        letterSpacing:".06em", textTransform:"uppercase", marginBottom:8}}>
        {m.owned ? "Ownership" : "Purchase Method"}
      </div>
      {m.owned ? (
        <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", gap:10,
          marginBottom:18, padding:"11px 14px", background:C.blueSubtle,
          border:"1px solid "+C.blueBorder, borderRadius:C.r2}}>
          <span style={{display:"inline-flex", alignItems:"center", gap:8,
            fontSize:13, fontWeight:700, color:C.blueDark, fontFamily:F}}>
            <I.home size={14} stroke={2.2}/> You already own this property
          </span>
          <button onClick={()=>set({...p, alreadyOwned:false, chosenStrategy:null})}
            style={{background:"none", border:"none", cursor:"pointer", padding:0,
              fontSize:12.5, fontWeight:600, color:C.textSub, fontFamily:F,
              textDecoration:"underline", textUnderlineOffset:2}}>
            Change
          </button>
        </div>
      ) : (
      <div style={{display:"flex", gap:0, marginBottom:18, padding:4,
        background:C.bgSubtle, borderRadius:C.r2, border:"1px solid "+C.border,
        ...(mobile && stickyTop ? {position:"sticky", top:stickyTop, zIndex:40} : {})}}>
        {[["cash","Cash",C.cashPos],["finance","Finance",C.green]].map(([id,label,accent]) => {
          const active = s===id;
          return (
            <button key={id} onClick={()=>u("chosenStrategy",id)}
              style={{
                flex:1, padding:"8px 14px", borderRadius:C.r1, border:"none",
                background: active ? accent : "transparent",
                color: active ? "#fff" : C.textSub,
                fontWeight: active?700:500, fontSize:13, cursor:"pointer", fontFamily:F,
                letterSpacing:"-0.005em",
                boxShadow: active ? "0 2px 6px -1px rgba(9,9,11,.25)" : "none",
                transition:"background .15s, color .15s, box-shadow .15s",
              }}>
              {label}
            </button>
          );
        })}
      </div>
      )}

      <div style={{display:"grid", gridTemplateColumns:mobile?"1fr":"1fr 1fr", gap:14}}>

        {/* Purchase — shared by both tabs */}
        <SectionBlock title={m.owned ? "Your Property" : "Purchase"} color={C.green} icon={I.tag}>
          {m.owned ? (
            <>
              <InputField label="Purchase Price" val={p.purchasePrice} set={v=>u("purchasePrice",v)} pre="$"
                note="Prefilled with today's estimated value from property records when available."
                mobile={mobile} />
              <InputField label="Current Loan Balance" val={p.ownedLoanBalance} set={v=>u("ownedLoanBalance",v)} pre="$"
                note="What you still owe. Enter 0 if you own it free and clear."
                mobile={mobile} />
              {(p.ownedLoanBalance||0) > 0 && (
                <InputField label="Current Monthly Payment (P&I)" val={p.ownedLoanPayment} set={v=>u("ownedLoanPayment",v)} pre="$"
                  note="Your existing principal + interest payment. Taxes and insurance stay under Expenses."
                  mobile={mobile} />
              )}
            </>
          ) : (
            <>
              <InputField label="Purchase Price" val={p.purchasePrice} set={v=>u("purchasePrice",v)} pre="$" mobile={mobile} />
              <InputField label="Purchase Costs" val={p.purchaseCostsPct ?? 3}
                set={v=>set({...p, purchaseCostsPct:v, closingItems:null, closingCosts:null})} suf="%"
                note={Array.isArray(p.closingItems) && p.closingItems.length
                  ? `Itemized (${p.closingItems.length} items) — typing here clears the breakdown`
                  : `= ${$(m.cc)} (closing, lender, title…)`}
                mobile={mobile} />
              <button onClick={()=>setItemize("closing")} {...btnStyle("secondary","sm", {marginBottom:12})}>
                <I.edit size={12}/> {Array.isArray(p.closingItems) && p.closingItems.length ? "Edit Itemized Costs" : "Itemize"}
              </button>
            </>
          )}
          <InputField label="Rehab Costs" val={p.repairCosts}
            set={v=>set({...p, repairCosts:v, repairItems:null})} pre="$"
            note={Array.isArray(p.repairItems) && p.repairItems.length ? `Itemized (${p.repairItems.length} items) — typing here clears the breakdown` : undefined}
            mobile={mobile} />
          <button onClick={()=>setItemize("repair")} {...btnStyle("secondary","sm", {marginBottom:12})}>
            <I.edit size={12}/> {Array.isArray(p.repairItems) && p.repairItems.length ? "Edit Itemized Rehab" : "Itemize"}
          </button>
          <InputField label="Hold Period (Months)" val={p.holdMonths ?? 6} set={v=>u("holdMonths",v)}
            note="Time to rehab (and for flips, to sell). Longer holds increase holding costs and reduce profit."
            mobile={mobile} />
          {m.rolledIn > 0 && <DataRow label="Costs Rolled Into Loan" value={$(m.rolledIn)} color={C.textSub} />}
        </SectionBlock>

        {/* Financing — Finance tab only */}
        {s==="finance" && (
        <SectionBlock title="Financing" color={C.blue} icon={I.building}>
          {(!Array.isArray(p.loans) || p.loans.length === 0) ? (
            <>
              <InputField label="Down Payment" val={p.downPaymentPct} set={v=>u("downPaymentPct",v)} suf="%" mobile={mobile} />
              <InputField label="Interest Rate" val={p.interestRate} set={v=>u("interestRate",v)} suf="%" mobile={mobile} />
              <DataRow label="Down Payment" value={$(m.down)} />
              <DataRow label="Loan Amount" value={$(m.loan)} />
              <DataRow label="Mortgage / mo" value={$mo(m.mtg)} />
              <button onClick={()=>u("loans", [newLoan()])}
                {...btnStyle("secondary","md", {width:"100%", justifyContent:"center", marginTop:10})}>
                <I.plus size={13}/> Advanced Loan Setup
              </button>
              <div style={{fontSize:11, color:C.textMuted, fontFamily:F, marginTop:6, lineHeight:1.5}}>
                Choose what to finance, interest-only loans, terms, and multiple loans.
              </div>
            </>
          ) : (
            <>
              {p.loans.map((ln, i) => {
                const setLn = patch => u("loans", p.loans.map(x => x.id === ln.id ? {...x, ...patch} : x));
                const amt = loanAmount(ln, p) + (i === 0 ? m.rolledIn : 0);
                return (
                  <div key={ln.id} style={{border:"1px solid "+C.border, borderRadius:C.r3, padding:"12px 12px 6px", marginBottom:12, background:C.bgSubtle}}>
                    <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10}}>
                      <span style={{fontSize:12, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:".04em", textTransform:"uppercase"}}>
                        Loan {i+1}
                      </span>
                      <button onClick={()=>u("loans", p.loans.filter(x => x.id !== ln.id))}
                        style={{background:"transparent", border:"none", cursor:"pointer", color:C.redDark,
                          fontSize:12, fontWeight:600, fontFamily:F, padding:"2px 4px"}}>
                        Remove
                      </button>
                    </div>
                    <label style={{fontSize:12, color:C.textSub, fontFamily:F, display:"block", marginBottom:5, fontWeight:500}}>What to Finance</label>
                    <select value={ln.financeOf} onChange={e=>setLn({financeOf:e.target.value})} style={{...iS(mobile), marginBottom:10}}>
                      <option value="purchase">Purchase Price</option>
                      <option value="rehab">Rehab Costs</option>
                      <option value="purchase_rehab">Purchase + Rehab Costs</option>
                      <option value="arv">After Repair Value (ARV)</option>
                      <option value="custom">Custom Amount</option>
                    </select>
                    {ln.financeOf === "custom" ? (
                      <InputField label="Loan Amount" val={ln.customAmount} set={v=>setLn({customAmount:v})} pre="$" mobile={mobile} />
                    ) : (
                      <InputField label="Loan-to-Value" val={ln.ltvPct} set={v=>setLn({ltvPct:v})} suf="%"
                        note={"Loan Amount: " + $(loanAmount(ln, p))} mobile={mobile} />
                    )}
                    <label style={{fontSize:12, color:C.textSub, fontFamily:F, display:"block", marginBottom:5, fontWeight:500}}>Loan Type</label>
                    <select value={ln.loanType} onChange={e=>setLn({loanType:e.target.value})} style={{...iS(mobile), marginBottom:10}}>
                      <option value="amortizing">Amortizing</option>
                      <option value="interest_only">Interest Only</option>
                    </select>
                    <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>
                      <InputField label="Interest Rate" val={ln.rate} set={v=>setLn({rate:v})} suf="%" mobile={mobile} />
                      <InputField label="Loan Term (Years)" val={ln.termYears} set={v=>setLn({termYears:v})} mobile={mobile} />
                    </div>
                    <DataRow label={"Loan " + (i+1) + " Payment / mo"} value={$mo(loanPayment(amt, ln))} />
                    {i === 0 && m.rolledIn > 0 && (
                      <div style={{fontSize:11, color:C.textMuted, fontFamily:F, padding:"0 0 8px"}}>
                        Includes {$(m.rolledIn)} of costs rolled into this loan.
                      </div>
                    )}
                  </div>
                );
              })}
              <button onClick={()=>u("loans", [...p.loans, newLoan(p.loans.length+1)])}
                {...btnStyle("secondary","md", {width:"100%", justifyContent:"center"})}>
                <I.plus size={13}/> Add a Loan
              </button>
              <button onClick={()=>u("loans", [])}
                style={{background:"transparent", border:"none", cursor:"pointer", color:C.textMuted,
                  fontSize:12, fontFamily:F, padding:"8px 4px 0", width:"100%", textAlign:"center"}}>
                Switch Back to Simple Financing
              </button>
            </>
          )}
        </SectionBlock>
        )}

        {/* Income — shared by both tabs (this used to hide on Finance) */}
        <SectionBlock title="Income" color={C.cashPos} icon={I.dollar}>
          {p.rentEstimate > 0 && (
            <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", gap:10,
              background:C.greenSubtle, border:"1px solid "+C.greenBorder, borderRadius:C.r2,
              padding:"10px 12px", marginBottom:12}}>
              <div style={{minWidth:0}}>
                <div style={{fontSize:10.5, fontWeight:700, color:C.greenDark, fontFamily:F, letterSpacing:".05em", textTransform:"uppercase"}}>
                  Market Rent Estimate
                </div>
                <div style={{fontSize:15, fontWeight:700, color:C.text, fontFamily:F, fontVariantNumeric:"tabular-nums", marginTop:1}}>
                  {$(p.rentEstimate)}/mo
                  {(p.rentEstLow > 0 && p.rentEstHigh > 0) && (
                    <span style={{fontSize:11.5, color:C.textSub, fontWeight:500}}> · {$(p.rentEstLow)} – {$(p.rentEstHigh)}</span>
                  )}
                </div>
              </div>
              {p.rentAmount !== p.rentEstimate && (
                <button onClick={()=>u("rentAmount", p.rentEstimate)} {...btnStyle("primary","sm")}>Use</button>
              )}
            </div>
          )}
          <div style={{position:"relative"}}>
            <InputField label="Monthly Rent" val={p.rentAmount} set={v=>u("rentAmount",v)} pre="$"
              suf={(rcOk(rcAuth) && apiLookup) ? "        " : undefined} mobile={mobile} />
            {(rcOk(rcAuth) && apiLookup) && (
              <button onClick={()=>setCompsOpen(true)} disabled={!p.address}
                title={p.address ? "Check rental comps" : "Enter the property address first"}
                style={{
                  position:"absolute", right:6, top: mobile ? 33 : 31, height: mobile ? 34 : 30,
                  display:"inline-flex", alignItems:"center", gap:6, padding:"0 12px",
                  background:`linear-gradient(135deg, ${C.greenSubtle} 0%, #fff 90%)`,
                  border:"1px solid "+C.greenBorder, borderRadius:9999,
                  color:C.greenDark, fontSize:12, fontWeight:700, fontFamily:F,
                  cursor: p.address ? "pointer" : "default",
                  opacity: p.address ? 1 : .5, boxShadow:C.sh1,
                }}>
                <I.search size={12} stroke={2.4}/> Comps
              </button>
            )}
          </div>
          <InputField label="Other Income / mo" val={p.otherIncome}
            set={v=>set({...p, otherIncome:v, incomeItems:null})} pre="$"
            note={Array.isArray(p.incomeItems) && p.incomeItems.length ? `Itemized (${p.incomeItems.length} items) — typing here clears the breakdown` : "Parking, laundry, storage…"}
            mobile={mobile} />
          <button onClick={()=>setItemize("income")} {...btnStyle("secondary","sm", {marginBottom:12})}>
            <I.edit size={12}/> {Array.isArray(p.incomeItems) && p.incomeItems.length ? "Edit Itemized Income" : "Itemize"}
          </button>
          <InputField label="Vacancy Rate" val={p.vacancyRate ?? 5} set={v=>u("vacancyRate",v)} suf="%" note="5% ≈ 18 vacant days/yr" mobile={mobile} />
          {(p.vacancyRate||0) > 0 && <DataRow label="Effective Rent / mo" value={$(m.effectiveRent)} color={C.textSub} />}
          <DataRow label="Yearly Rent (Gross)" value={$((p.rentAmount||0)*12)} />
        </SectionBlock>

        {/* Results — Finance tab only (cash results live in the Summary card) */}
        {s==="finance" && (
          <SectionBlock title="Financed Results" color={C.green} icon={I.chart}>
            <DataRow label="Total Loan Amount" value={$(m.loan)} />
            <DataRow label="Loan Payments / mo" value={$mo(m.mtg)} />
            <DataRow label="Cash Needed" value={$(m.finOOP)} />
            <div style={{fontSize:11, color:C.textMuted, fontFamily:F, padding:"2px 0 6px"}}>
              Purchase + rehab + purchase costs, minus loan proceeds
            </div>
            <DataRow label="Cash Flow / mo" value={$mo(m.finCF)} color={cfC(m.finCF)} />
            <DataRow label="Cash-on-Cash" value={pct(m.finCoC)} color={cfC(m.finCoC)} />
            <DataRow label="Cap Rate" value={pct(m.finCap)} />
            <DataRow label="Years to Payoff" value={m.payoff>0 ? m.payoff.toFixed(1)+" yrs" : "—"} />
          </SectionBlock>
        )}

        {/* Monthly expenses — shared */}
        <SectionBlock title="Monthly Expenses" color={C.amber} icon={I.receipt}>
          {Array.isArray(p.expenseItems) && p.expenseItems.length ? (
            <>
              {p.expenseItems.map(it => (
                <DataRow key={it.id} label={it.name}
                  value={$(Math.round(expenseMonthly(it, p.rentAmount||0))) + "/mo"} />
              ))}
              <div style={{display:"flex", gap:8, margin:"12px 0"}}>
                <button onClick={()=>setItemize("expenses")} {...btnStyle("secondary","sm", {flex:1, justifyContent:"center"})}>
                  <I.edit size={12}/> Edit Items
                </button>
                <button onClick={()=>u("expenseItems", null)}
                  style={{background:"transparent", border:"none", cursor:"pointer", color:C.textMuted,
                    fontSize:12, fontFamily:F, padding:"4px 8px"}}>
                  Switch to Simple
                </button>
              </div>
            </>
          ) : (
            <>
              <InputField label="Property Tax / mo" val={p.expPropTax}
                set={v=>set({...p, expPropTax:v, expPropTaxAuto:false})} pre="$" mobile={mobile} />
              <InputField label="Utilities / mo" val={p.expUtilities} set={v=>u("expUtilities",v)} pre="$" mobile={mobile} />
              <InputField label="Management / mo" val={p.expManagement} set={v=>u("expManagement",v)} pre="$" mobile={mobile} />
              <InputField label="Insurance / mo" val={p.expInsurance}
                set={v=>set({...p, expInsurance:v, expInsuranceAuto:false})} pre="$"
                note="Estimated from the address — adjust anytime" mobile={mobile} />
              <button onClick={()=>setItemize("expenses")} {...btnStyle("secondary","sm", {marginBottom:12})}>
                <I.edit size={12}/> Itemize Expenses
              </button>
            </>
          )}
          <DataRow label="Total Expenses / mo" value={$(m.exp)} />
          <DataRow label="NOI / yr" value={$(m.noi*12)} />
        </SectionBlock>

        {/* After Repair Value — drives the BRRRR / flip exits on both tabs */}
        <SectionBlock title="After Repair Value (ARV)" color={C.blue} icon={I.trendingUp}>
          <InputField label="After Repair Value (ARV)" val={p.homeValueHigh||0}
            set={v=>{ set({...p, homeValueHigh:v, flipSalePrice:v, brrrCashOut:Math.round(v*0.75)}); }} pre="$"
            note="What the property will be worth after repairs. Drives BRRRR and Fix & Flip below."
            mobile={mobile} />
          {(rcOk(rcAuth) && apiLookup) && (
            <button onClick={checkHomeValue} disabled={avmBusy}
              {...btnStyle("secondary","md", {width:"100%", justifyContent:"center", marginBottom:10})}>
              {avmBusy ? "Checking…" : <><I.search size={13}/> Check Home Value</>}
            </button>
          )}
          {avmMsg?.kind === "ok" ? (
            <div style={{
              background:`linear-gradient(150deg, ${C.blueSubtle} 0%, #fff 80%)`,
              border:"1px solid "+C.blueBorder, borderRadius:C.r3,
              padding:"14px 16px", textAlign:"center", marginBottom:12, boxShadow:C.sh1,
            }}>
              <div style={{fontSize:10.5, fontWeight:700, color:C.blueDark, fontFamily:F,
                letterSpacing:".07em", textTransform:"uppercase"}}>DealHive Value Estimate</div>
              <div style={{fontSize:26, fontWeight:800, color:C.text, fontFamily:F,
                fontVariantNumeric:"tabular-nums", letterSpacing:"-0.025em", marginTop:2}}>
                {$(avmMsg.med)}
              </div>
              <div style={{display:"inline-flex", alignItems:"center", gap:6, marginTop:6,
                background:"#fff", border:"1px solid "+C.border, borderRadius:9999,
                padding:"3px 11px", fontSize:11.5, color:C.textSub, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>
                Range {$(avmMsg.lo)} – {$(avmMsg.hi)}
              </div>
              <div style={{fontSize:11.5, color:C.textMuted, fontFamily:F, marginTop:7, lineHeight:1.5}}>
                ARV pre-filled at the median estimate — adjust it up to match your rehab plan.
              </div>
            </div>
          ) : avmMsg && (
            <div style={{fontSize:12.5, fontFamily:F, lineHeight:1.55, borderRadius:C.r2, padding:"9px 12px",
              marginBottom:10, background:C.redSubtle, border:"1px solid "+C.redBorder, color:C.redDark}}>
              {avmMsg.text}
            </div>
          )}
          {p.homeValueMedian > 0 && <DataRow label="DealHive Estimate" value={$(p.homeValueMedian)} />}
          {p.taxValue > 0 && <DataRow label="Tax Value" value={$(p.taxValue)} />}
        </SectionBlock>

        {/* Summary — the analyzer relocates this to sit right above Notes */}
        {!externalSummary && <DealSummaryBlock p={p} m={m} exit={xtra}/>}

      </div>

      {/* Analyzer slot — the cash recommendation card renders here, right
          under the ARV section and above the exit-strategy toggle */}
      {midSlot}

      {/* Exit strategies — BRRRR / Fix & Flip toggle, both tabs (the math
          adapts: financed exits carry debt service and loan payoffs) */}
      <div style={{marginTop:14}}>
        <div style={{fontSize:12, fontWeight:700, color:C.textSub, fontFamily:F,
          letterSpacing:".06em", textTransform:"uppercase", marginBottom:8}}>
          Explore Exit Strategies
        </div>
        <div ref={exitRowRef} style={{display:"flex", gap:0, padding:4, background:C.bgSubtle,
          borderRadius:C.r2, border:"1px solid "+C.border, marginBottom:14}}>
          {[["buyhold","Buy & Hold",C.cashPos],["brrrr","BRRRR",C.purple],["flip","Fix & Flip",C.amber]].map(([id,label,accent], i) => {
            const active = (xtra || "buyhold") === id;
            return (
              <button key={id} onClick={()=>setXtra(id === "buyhold" || active ? null : id)}
                className={exitPulse && active ? "dh-exit-pulse" : undefined}
                style={{
                  flex:1, padding:"8px 14px", borderRadius:C.r1, border:"none",
                  background: active ? accent : "transparent",
                  color: active ? "#fff" : C.textSub,
                  fontWeight: active?700:500, fontSize:13, cursor:"pointer", fontFamily:F,
                  letterSpacing:"-0.005em",
                  boxShadow: active ? "0 2px 6px -1px rgba(9,9,11,.25)" : "none",
                  transition:"background .15s, color .15s, box-shadow .15s",
                  "--dh-pulse": `${accent}66`,
                }}>
                {label}
              </button>
            );
          })}
        </div>

        {xtra === "brrrr" && (
          <SectionBlock title="BRRRR Estimate" color={C.purple} icon={I.cycle}>
            {!(p.homeValueHigh > 0) && (
              <div style={{fontSize:12.5, color:C.amberDark, background:C.amberSubtle, border:"1px solid "+C.amberBorder,
                padding:"9px 12px", borderRadius:C.r2, marginBottom:12, fontFamily:F}}>
                Enter an After Repair Value above to size the refinance.
              </div>
            )}
            <InputField label="Cash Out Amount" val={p.brrrCashOut || Math.round((p.homeValueHigh||0)*0.75)}
              set={v=>u("brrrCashOut",v)} pre="$" note="75% of your ARV" mobile={mobile} />
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>
              <InputField label="Refi Interest Rate" val={p.brrrRate ?? 7.5} set={v=>u("brrrRate",v)} suf="%" mobile={mobile} />
              <InputField label="Refi Loan Term (Years)" val={p.brrrTermYears ?? 30} set={v=>u("brrrTermYears",v)} mobile={mobile} />
            </div>
            <InputField label="Refi Closing Costs" val={p.brrrRefiCostPct ?? 2} set={v=>u("brrrRefiCostPct",v)} suf="%"
              note={`= ${$(m.brrrRefiCost)} off your cash out`} mobile={mobile} />
            <DataRow label="Refi Closing Costs" value={"-" + $(m.brrrRefiCost)} color={C.red} />
            {(s === "finance" || (m.owned && m.ownedBal > 0)) &&
              <DataRow label={m.owned ? "Pays Off Current Loan" : "Pays Off Existing Loans"}
                value={"-" + $(m.owned ? m.ownedBal : m.loan)} color={C.red} />}
            <DataRow label="Net Cash at Refi"
              value={$((s === "cash" && !m.owned) ? m.brrrCashNet : m.brrrNetCash)}
              color={cfC((s === "cash" && !m.owned) ? m.brrrCashNet : m.brrrNetCash)} />
            <DataRow label={"Holding Costs (" + m.holdMonths + " mo)"} value={"-" + $(m.brrrHolding)} color={C.red} />
            <DataRow label="Est. Mortgage / mo (After Refi)" value={$mo(m.brrrMtg)} />
            <DataRow label="BRRRR Cash Flow / mo" value={$mo(m.brrrCF)} color={cfC(m.brrrCF)} />
            {(s === "finance" || m.owned) && m.brrrNetCash < 0 && (
              <div style={{fontSize:12, color:C.amberDark, background:C.amberSubtle, border:"1px solid "+C.amberBorder,
                padding:"8px 12px", borderRadius:C.r2, marginTop:8, fontFamily:F, lineHeight:1.5}}>
                The refinance doesn't fully cover your existing loans — you'd bring cash to close the refi.
              </div>
            )}
          </SectionBlock>
        )}

        {xtra === "flip" && (
          <SectionBlock title="Fix & Flip" color={C.amber} icon={I.hammer}>
            {!(p.homeValueHigh > 0) && (
              <div style={{fontSize:12.5, color:C.amberDark, background:C.amberSubtle, border:"1px solid "+C.amberBorder,
                padding:"9px 12px", borderRadius:C.r2, marginBottom:12, fontFamily:F}}>
                Enter an After Repair Value above to set the sale price.
              </div>
            )}
            <InputField label="Sale Price (ARV)" val={p.flipSalePrice||0} set={v=>u("flipSalePrice",v)} pre="$"
              note="From your ARV above — adjust if you'd list differently" mobile={mobile} />
            <InputField label="Agent Fee" val={p.agentFeePct ?? 6} set={v=>u("agentFeePct",v)} suf="%" mobile={mobile} />
            {s === "cash" ? (
              <>
                <DataRow label={m.owned ? "New Cash In (Rehab)" : "Total Into Deal"} value={$(m.cashOOP)} />
                <DataRow label="Agent Fee" value={$(m.agentFee)} />
                <DataRow label={"Holding Costs (" + m.holdMonths + " mo)"} value={$(m.flipHolding)} />
                {m.owned && m.ownedBal > 0 && <DataRow label="Loan Payoff at Sale" value={$(m.ownedBal)} />}
                <DataRow label={m.owned ? "Net Cash From Sale" : "Net Profit"} value={$(m.flipProfit)} color={cfC(m.flipProfit)} />
                <DataRow label={m.owned ? "Return on New Cash" : "ROI"} value={pct(m.flipROI)} color={cfC(m.flipProfit)} />
              </>
            ) : (
              <>
                <DataRow label="Total Cash In" value={$(m.finOOP)} />
                <DataRow label="Agent Fee" value={$(m.agentFee)} />
                <DataRow label={"Holding Costs (" + m.holdMonths + " mo, incl. loan payments)"} value={$(m.finFlipHolding)} />
                <DataRow label="Loan Payoff at Sale" value={$(m.loan)} />
                <DataRow label="Net Profit" value={$(m.finFlipProfit)} color={cfC(m.finFlipProfit)} />
                <DataRow label="ROI on Cash" value={pct(m.finFlipROI)} color={cfC(m.finFlipProfit)} />
              </>
            )}
          </SectionBlock>
        )}
      </div>

      {/* Itemize sheets */}
      {itemize === "closing" && (
        <ItemizeSheet title="Itemized Purchase Costs"
          items={p.closingItems} prefill={CLOSING_PREFILL}
          price={p.purchasePrice||0}
          loanAmt={Array.isArray(p.loans) && p.loans.length ? p.loans.reduce((sum,l)=>sum+loanAmount(l,p),0) : m.loan}
          onApply={(items, totals)=>{ set({...p, closingItems:items, closingCosts:totals.total}); setItemize(null); }}
          onClose={()=>setItemize(null)} mobile={mobile} />
      )}
      {compsOpen && (
        <RentCompsSheet p={p} apiLookup={apiLookup} rcAuth={rcAuth} tier={tier} onUpgrade={onUpgrade} mobile={mobile}
          onUseRent={(rent, lo, hi) => {
            set({...p, rentAmount: rent, rentEstimate: rent, rentEstLow: lo, rentEstHigh: hi});
            setCompsOpen(false);
          }}
          onClose={()=>setCompsOpen(false)} />
      )}
      {itemize === "income" && (
        <ItemizeSheet title="Itemized Other Income"
          items={p.incomeItems} prefill={INCOME_PREFILL}
          typeOptions={AMOUNT_ONLY_TYPES} allowRollIn={false} perMonth
          computeValue={it => Math.round(it.value || 0)}
          onApply={(items, totals)=>{ set({...p, incomeItems:items, otherIncome:totals.total}); setItemize(null); }}
          onClose={()=>setItemize(null)} mobile={mobile} />
      )}
      {itemize === "expenses" && (
        <ItemizeSheet title="Itemized Operating Expenses"
          items={p.expenseItems} prefill={() => EXPENSES_PREFILL(p)}
          typeOptions={EXPENSE_TYPES} allowRollIn={false} perMonth
          computeValue={it => Math.round(expenseMonthly(it, p.rentAmount||0))}
          onApply={(items)=>{ set({...p, expenseItems:items}); setItemize(null); }}
          onClose={()=>setItemize(null)} mobile={mobile} />
      )}
      {itemize === "repair" && (
        <ItemizeSheet title="Itemized Rehab Costs"
          items={p.repairItems} prefill={REPAIR_PREFILL}
          price={p.purchasePrice||0}
          loanAmt={Array.isArray(p.loans) && p.loans.length ? p.loans.reduce((sum,l)=>sum+loanAmount(l,p),0) : m.loan}
          onApply={(items, totals)=>{ set({...p, repairItems:items, repairCosts:totals.total}); setItemize(null); }}
          onClose={()=>setItemize(null)} mobile={mobile} />
      )}

      {/* Appreciation Projector */}
      <AppreciationProjector homeValue={p.homeValueMedian || p.homeValueHigh} purchasePrice={p.purchasePrice} mobile={mobile} />
      </>
      )}

    </div>
  );
}

// -- Dashboard -----------------------------------------------------------------
function Dashboard({properties, onSelect, onAdd, mobile}) {
  const [mapReady, setMapReady] = useState(!!window.L);
  useEffect(() => {
    if (window.L) { setMapReady(true); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    s.onload = () => setMapReady(true);
    document.head.appendChild(s);
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(l);
  }, []);

  const occProps    = properties.filter(p => p.occupied);
  const occupied    = occProps.length;
  const totalCF     = properties.reduce((s,p) => s+calc(p).chosenCF, 0);
  const occCF       = occProps.reduce((s,p) => s+calc(p).chosenCF, 0);
  const totalRent   = properties.reduce((s,p) => s+(p.rentAmount||0), 0);
  const occRent     = occProps.reduce((s,p) => s+(p.rentAmount||0), 0);
  // Out of pocket for occupied properties, per each property's chosen strategy:
  // financed deals count down payment + repairs + closing; cash deals count
  // purchase + repairs.
  const occOOP = occProps.reduce((s,p) => s+calc(p).chosenOOP, 0);
  const allOOP = properties.reduce((s,p) => s+calc(p).chosenOOP, 0);
  // chosenOOP already bundles repairs in; split them out so each card can show
  // Out of pocket (acquisition: purchase for cash, down + closing for finance)
  // + Repairs = Total, without double-counting.
  const occRepairs = occProps.reduce((s,p) => s+(p.repairCosts||0), 0);
  const allRepairs = properties.reduce((s,p) => s+(p.repairCosts||0), 0);
  const occAcq = occOOP - occRepairs;
  const allAcq = allOOP - allRepairs;
  // Cash-flow figure without the "/mo" suffix (rendered separately, smaller).
  const cfFig = (n) => { const r = Math.round(n||0); return (r<0?"-$":"$") + Math.abs(r).toLocaleString(); };
  const alerts     = properties.filter(p => {
    const d = dU(p.leaseEnd);
    return p.tenantStatus==="Late" || (d!=null && d<=60 && d>=0);
  });

  // Out of pocket + repairs = total, shown at the bottom of the unit cards.
  const oopBreakdown = (acq, repairs, total) => (
    <div style={{marginTop:"auto", paddingTop:12, borderTop:"1px solid "+C.border}}>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:8, marginBottom:5}}>
        <span style={{fontSize:11, color:C.textMuted, fontFamily:F}}>Out of pocket</span>
        <span style={{fontSize:12, fontWeight:500, color:C.textSub, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>{$(acq)}</span>
      </div>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:8, marginBottom:7}}>
        <span style={{fontSize:11, color:C.textMuted, fontFamily:F}}>+ Repairs</span>
        <span style={{fontSize:12, fontWeight:500, color:C.textSub, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>{$(repairs)}</span>
      </div>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:8, paddingTop:7, borderTop:"1px solid "+C.border}}>
        <span style={{fontSize:12, fontWeight:700, color:C.text, fontFamily:F}}>Total</span>
        <span style={{fontSize:14, fontWeight:700, color:C.text, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>{$(total)}</span>
      </div>
    </div>
  );

  return (
    <div style={{padding:mobile?"20px 16px 100px":"32px 32px"}}>
      <PageHeader
        title="Portfolio"
        subtitle={properties.length===0
          ? "Welcome — let's add your first property."
          : `${properties.length} ${properties.length===1?"property":"properties"} in your portfolio`}
        action={<button onClick={onAdd} {...btnStyle("primary","md")}><I.plus size={14}/> Add property</button>}
      />

      {/* KPI grid */}
      <div style={{display:"grid", gridTemplateColumns:mobile?"1fr 1fr":"repeat(4,1fr)", gap:12, marginBottom:28, alignItems:"stretch"}}>
        <Card style={{padding:18, display:"flex", flexDirection:"column"}}>
          <div style={{fontSize:12, color:C.textSub, fontWeight:500, fontFamily:F}}>Cash flow / mo</div>
          <div style={{fontSize:26, fontWeight:700, color:cfC(occCF), fontFamily:F, lineHeight:1.15, letterSpacing:"-0.025em", marginTop:6, fontVariantNumeric:"tabular-nums", whiteSpace:"nowrap"}}>
            {cfFig(occCF)}<span style={{fontSize:13, fontWeight:500, color:C.textMuted, letterSpacing:0}}>/mo</span>
          </div>
          <div style={{fontSize:12, color:C.textMuted, fontFamily:F, marginTop:6}}>
            From {occupied} occupied {occupied===1?"property":"properties"}
          </div>
          <div style={{marginTop:"auto", paddingTop:12, borderTop:"1px solid "+C.border, display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:8}}>
            <span style={{fontSize:11, color:C.textMuted, fontFamily:F}}>Incl. vacant</span>
            <span style={{fontSize:13, fontWeight:600, color:cfC(totalCF), fontFamily:F, fontVariantNumeric:"tabular-nums"}}>{$mo(totalCF)}</span>
          </div>
        </Card>
        <Card style={{padding:18, display:"flex", flexDirection:"column"}}>
          <div style={{fontSize:12, color:C.textSub, fontWeight:500, fontFamily:F}}>Rent collected / mo</div>
          <div style={{fontSize:26, fontWeight:700, color:C.text, fontFamily:F, lineHeight:1.15, letterSpacing:"-0.025em", marginTop:6, fontVariantNumeric:"tabular-nums", whiteSpace:"nowrap"}}>
            {$(occRent)}
          </div>
          <div style={{fontSize:12, color:C.textMuted, fontFamily:F, marginTop:6}}>
            From {occupied} occupied {occupied===1?"property":"properties"}
          </div>
          <div style={{marginTop:"auto", paddingTop:12, borderTop:"1px solid "+C.border, display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:8}}>
            <span style={{fontSize:11, color:C.textMuted, fontFamily:F}}>Incl. vacant</span>
            <span style={{fontSize:13, fontWeight:600, color:C.text, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>{$(totalRent)}</span>
          </div>
        </Card>
        <Card style={{padding:18, display:"flex", flexDirection:"column"}}>
          <div style={{fontSize:12, color:C.textSub, fontWeight:500, fontFamily:F}}>Occupied units</div>
          <div style={{fontSize:26, fontWeight:700, color:C.text, fontFamily:F, lineHeight:1.15, letterSpacing:"-0.025em", marginTop:6, fontVariantNumeric:"tabular-nums", whiteSpace:"nowrap"}}>
            {occupied}<span style={{fontSize:14, fontWeight:500, color:C.textMuted, letterSpacing:0}}> of {properties.length}</span>
          </div>
          <div style={{fontSize:12, color:C.textMuted, fontFamily:F, marginTop:6}}>
            {properties.length>0 ? Math.round(occupied/Math.max(properties.length,1)*100)+"% occupied" : "—"}
          </div>
          {oopBreakdown(occAcq, occRepairs, occOOP)}
        </Card>
        <Card style={{padding:18, display:"flex", flexDirection:"column"}}>
          <div style={{fontSize:12, color:C.textSub, fontWeight:500, fontFamily:F}}>Total units</div>
          <div style={{fontSize:26, fontWeight:700, color:C.text, fontFamily:F, lineHeight:1.15, letterSpacing:"-0.025em", marginTop:6, fontVariantNumeric:"tabular-nums", whiteSpace:"nowrap"}}>
            {properties.length}
          </div>
          <div style={{fontSize:12, color:C.textMuted, fontFamily:F, marginTop:6}}>
            {occupied} occupied · {Math.max(properties.length-occupied,0)} vacant
          </div>
          {oopBreakdown(allAcq, allRepairs, allOOP)}
        </Card>
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div style={{marginBottom:20}}>
          <div style={{fontSize:12, fontWeight:600, color:C.textSub, fontFamily:F, letterSpacing:".03em", textTransform:"uppercase", marginBottom:10}}>
            Needs attention
          </div>
          {alerts.map(p => {
            const isLate = p.tenantStatus==="Late";
            const days = dU(p.leaseEnd);
            const palette = isLate
              ? {bg:C.redSubtle, border:C.redBorder, text:C.redDark}
              : {bg:C.amberSubtle, border:C.amberBorder, text:C.amberDark};
            return (
              <div key={p.id} onClick={()=>onSelect(p.id)}
                style={{background:palette.bg, border:"1px solid "+palette.border,
                  borderRadius:C.r3, padding:"12px 14px", marginBottom:8,
                  display:"flex", gap:12, alignItems:"center", cursor:"pointer",
                  transition:"transform .12s, box-shadow .12s"}}
                onMouseEnter={e=>e.currentTarget.style.boxShadow=C.sh2}
                onMouseLeave={e=>e.currentTarget.style.boxShadow="none"}>
                <div style={{
                  width:32, height:32, borderRadius:C.r2, background:"rgba(255,255,255,.6)",
                  border:"1px solid "+palette.border,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  color:palette.text, flexShrink:0,
                }}><I.alert size={15}/></div>
                <div style={{flex:1, minWidth:0}}>
                  <div style={{fontWeight:600, color:palette.text, fontSize:13, fontFamily:F, letterSpacing:"-0.005em"}}>
                    {isLate ? "Rent is late" : `Lease expires in ${days} day${days===1?"":"s"}`}
                  </div>
                  <div style={{fontSize:13, color:C.text, fontFamily:F, marginTop:1,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
                    {p.address} · {p.tenantName||"Tenant"}
                  </div>
                </div>
                <span style={{color:palette.text, opacity:.7, display:"inline-flex"}}><I.chevronRight size={16}/></span>
              </div>
            );
          })}
        </div>
      )}

      {/* Map */}
      {properties.length > 0 && (
        <div style={{marginBottom:28}}>
          <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10}}>
            <div style={{fontSize:12, fontWeight:600, color:C.textSub, fontFamily:F, letterSpacing:".03em", textTransform:"uppercase"}}>
              Map
            </div>
          </div>
          <Card style={{padding:0, overflow:"hidden", height:mobile?260:360}}>
            {mapReady
              ? <MapView properties={properties} onSelect={onSelect} />
              : <div style={{height:"100%", display:"flex", alignItems:"center",
                  justifyContent:"center", color:C.textMuted, fontFamily:F, fontSize:13}}>Loading map…</div>}
          </Card>
        </div>
      )}

      {/* Property grid */}
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14}}>
        <div style={{fontSize:12, fontWeight:600, color:C.textSub, fontFamily:F, letterSpacing:".03em", textTransform:"uppercase"}}>
          Properties
        </div>
        <span style={{fontSize:12, color:C.textMuted, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>{properties.length} total</span>
      </div>

      {properties.length === 0 ? (
        <EmptyState
          icon={<I.building size={22}/>}
          title="No properties yet"
          body="Add your first property to start tracking cash flow, lease dates, and projects."
          action={<button onClick={onAdd} {...btnStyle("primary","lg")}><I.plus size={14}/> Add first property</button>}
        />
      ) : (
        <div style={{display:"grid", gridTemplateColumns:mobile?"1fr":"repeat(auto-fill,minmax(300px,1fr))", gap:14}}>
          {properties.map(p => {
            const m = calc(p), ob = obBadge(p), days = dU(p.leaseEnd), st = stStyle(p.tenantStatus);
            return (
              <Card key={p.id} onClick={()=>onSelect(p.id)} hover style={{cursor:"pointer"}}>
                {p.lat && p.lng ? (
                  <div style={{position:"relative", height:140, overflow:"hidden", background:C.bgSubtle}}>
                    <SafeImg src={svUrl(p.lat,p.lng,900,280)} fallback={imgPlaceholder()}
                      style={{width:"100%", height:"100%", objectFit:"cover"}} />
                    <div style={{position:"absolute", inset:0, background:"linear-gradient(to bottom,transparent 35%,rgba(9,9,11,.7))"}} />
                    <div style={{position:"absolute", bottom:10, left:14, right:14, display:"flex", justifyContent:"space-between", alignItems:"flex-end", gap:8}}>
                      <div style={{minWidth:0}}>
                        <div style={{color:"white", fontWeight:600, fontSize:14, fontFamily:F, letterSpacing:"-0.01em",
                          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{p.address}</div>
                        <div style={{color:"rgba(255,255,255,.8)", fontSize:12, fontFamily:F, marginTop:1}}>{p.city}, {p.state}</div>
                      </div>
                    </div>
                    <div style={{position:"absolute", top:10, right:10}}>
                      <Badge label={ob.label} bg={ob.bg} c={ob.c} dot/>
                    </div>
                  </div>
                ) : (
                  <div style={{padding:"14px 16px", borderBottom:"1px solid "+C.border,
                    display:"flex", justifyContent:"space-between", alignItems:"center", gap:8}}>
                    <div style={{minWidth:0}}>
                      <div style={{fontWeight:600, fontSize:14, color:C.text, fontFamily:F, letterSpacing:"-0.01em",
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{p.address}</div>
                      <div style={{fontSize:12, color:C.textSub, fontFamily:F, marginTop:1}}>{p.city}, {p.state}</div>
                    </div>
                    <Badge label={ob.label} bg={ob.bg} c={ob.c} dot/>
                  </div>
                )}
                <div style={{padding:"14px"}}>
                  <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:1, marginBottom:12,
                    background:C.border, borderRadius:C.r2, overflow:"hidden", border:"1px solid "+C.border}}>
                    {[["CF/mo",m.chosenCF,$mo(m.chosenCF)],["CoC",m.chosenCoC,pct(m.chosenCoC)],["Cap",m.chosenCap,pct(m.chosenCap)]].map(([l,v,sv]) => (
                      <div key={l} style={{textAlign:"center", background:C.card, padding:"10px 6px"}}>
                        <div style={{fontSize:11.5, color:C.textSub, fontFamily:F, fontWeight:500, letterSpacing:".03em", textTransform:"uppercase"}}>{l}</div>
                        <div style={{fontSize:14, fontWeight:700, marginTop:3,
                          color:["CF/mo","CoC"].includes(l)?cfC(v):C.text, fontFamily:F, fontVariantNumeric:"tabular-nums", letterSpacing:"-0.01em"}}>{sv}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                    <Badge label={p.tenantStatus} bg={st.bg} c={st.c} dot/>
                    <span style={{fontSize:12, color:C.textMuted, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>
                      {p.beds}bd · {p.baths}ba{p.sqft?` · ${(p.sqft/1000).toFixed(1)}k sqft`:""}
                    </span>
                  </div>
                  {days!=null && days<=60 && days>=0 && (
                    <div style={{marginTop:10, background:C.amberSubtle, borderRadius:C.r1, padding:"5px 10px",
                      fontSize:11, color:C.amberDark, fontWeight:500, fontFamily:F,
                      display:"flex", alignItems:"center", gap:5}}>
                      <I.alert size={11}/> Lease expires in {days} {days===1?"day":"days"}
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
          <button onClick={onAdd}
            style={{border:"1px dashed "+C.borderHover, borderRadius:C.r4, padding:28,
              display:"flex", flexDirection:"column", alignItems:"center", cursor:"pointer",
              color:C.textMuted, gap:8, minHeight:140, justifyContent:"center",
              background:"transparent", fontFamily:F,
              transition:"border-color .15s, color .15s, background .15s"}}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=C.green;e.currentTarget.style.color=C.green;e.currentTarget.style.background=C.greenSubtle;}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor=C.borderHover;e.currentTarget.style.color=C.textMuted;e.currentTarget.style.background="transparent";}}>
            <div style={{
              width:36, height:36, borderRadius:"50%",
              border:"1px solid currentColor",
              display:"flex", alignItems:"center", justifyContent:"center",
            }}><I.plus size={18}/></div>
            <div style={{fontSize:13, fontWeight:600}}>Add property</div>
          </button>
        </div>
      )}
    </div>
  );
}

// -- My Properties -------------------------------------------------------------
function MyProperties({properties, onSelect, onAdd, onDelete, mobile}) {
  const [search,  setSearch] = useState("");
  const [filter,  setFilter] = useState("all");

  const filtered = properties.filter(p => {
    const ms = !search || p.address.toLowerCase().includes(search.toLowerCase()) || (p.city||"").toLowerCase().includes(search.toLowerCase());
    const mf = filter==="all" || (filter==="occupied"&&p.occupied) || (filter==="vacant"&&!p.occupied) || (filter==="late"&&p.tenantStatus==="Late");
    return ms && mf;
  });

  const totalRent = properties.reduce((s,p) => s+(p.rentAmount||0), 0);
  const totalCF   = properties.reduce((s,p) => s+calc(p).chosenCF, 0);

  return (
    <div style={{padding:mobile?"20px 16px 100px":"32px 32px"}}>
      <PageHeader title="Properties" subtitle={`${properties.length} in your portfolio`}
        action={<button onClick={onAdd} {...btnStyle("primary","md")}><I.plus size={14}/> Add property</button>} />

      <div style={{display:"grid", gridTemplateColumns:mobile?"1fr 1fr":"repeat(4,1fr)", gap:12, marginBottom:24}}>
        <StatCard label="Total" value={properties.length} icon={<I.building size={16}/>}/>
        <StatCard label="Occupied" value={`${properties.filter(p=>p.occupied).length}/${properties.length||0}`} icon={<I.check size={16}/>}/>
        <StatCard label="Rent / mo" value={$(totalRent)} icon={<I.chart size={16}/>}/>
        <StatCard label="Net CF / mo" value={$mo(totalCF)} color={cfC(totalCF)} icon={<I.chart size={16}/>}/>
      </div>

      <div style={{display:"flex", gap:10, marginBottom:16, flexWrap:"wrap"}}>
        <div style={{position:"relative", flex:1, minWidth:200}}>
          <span style={{position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", color:C.textMuted, pointerEvents:"none", display:"inline-flex"}}>
            <I.search size={15}/>
          </span>
          <input value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="Search by address or city"
            style={{...iS(mobile), paddingLeft:36}} />
        </div>
        <div style={{display:"flex", gap:6, flexWrap:"wrap"}}>
          {[["all","All"],["occupied","Occupied"],["vacant","Vacant"],["late","Late"]].map(([id,label]) => (
            <button key={id} onClick={()=>setFilter(id)} {...btnStyle(filter===id?"primary":"secondary","sm")}>{label}</button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<I.search size={20}/>}
          title={search ? "No matches" : "No properties yet"}
          body={search ? "Try a different address or city, or clear filters." : "Add your first property to start tracking it."}
          action={!search && <button onClick={onAdd} {...btnStyle("primary","md")}><I.plus size={14}/> Add property</button>}
        />
      ) : (
        <Card padding={0}>
          {!mobile && (
            <div style={{display:"grid", gridTemplateColumns:"2fr 1fr 1.5fr 1fr 1fr 1fr auto",
              gap:12, padding:"11px 16px", background:C.bgSubtle, borderBottom:"1px solid "+C.border,
              fontSize:11, fontWeight:600, color:C.textSub, textTransform:"uppercase", letterSpacing:".04em", fontFamily:F}}>
              {["Property","Type","Tenant","Cash flow","CoC","Status",""].map(h => <div key={h}>{h}</div>)}
            </div>
          )}
          {filtered.map((p,i) => {
            const m = calc(p), st = stStyle(p.tenantStatus);
            return (
              <div key={p.id} style={{borderBottom:i<filtered.length-1?"1px solid "+C.border:"none"}}>
                {mobile ? (
                  <div onClick={()=>onSelect(p.id)}
                    style={{padding:14, cursor:"pointer", display:"flex", gap:12, alignItems:"center"}}>
                    {p.lat && p.lng ? (
                      <div style={{width:54, height:54, borderRadius:C.r2, overflow:"hidden", flexShrink:0,
                        border:"1px solid "+C.border, background:C.bgSubtle}}>
                        <SafeImg src={svUrl(p.lat,p.lng,120,120)} fallback={imgPlaceholder(20)}
                          style={{width:"100%", height:"100%", objectFit:"cover"}} />
                      </div>
                    ) : (
                      <div style={{width:54, height:54, borderRadius:C.r2, background:C.bgSubtle,
                        display:"flex", alignItems:"center", justifyContent:"center", color:C.textMuted, flexShrink:0}}>
                        <I.building size={20}/>
                      </div>
                    )}
                    <div style={{flex:1, minWidth:0}}>
                      <div style={{fontWeight:600, fontSize:14, color:C.text, fontFamily:F, letterSpacing:"-0.01em",
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{p.address}</div>
                      <div style={{fontSize:12, color:C.textSub, fontFamily:F, marginTop:1}}>{p.city}, {p.state}</div>
                      <div style={{display:"flex", gap:8, marginTop:6, alignItems:"center"}}>
                        <span style={{fontSize:13, fontWeight:700, color:cfC(m.chosenCF), fontFamily:F, fontVariantNumeric:"tabular-nums"}}>{$mo(m.chosenCF)}</span>
                        <Badge label={p.tenantStatus} bg={st.bg} c={st.c} dot/>
                      </div>
                    </div>
                    <span style={{color:C.textMuted, display:"inline-flex"}}><I.chevronRight size={16}/></span>
                  </div>
                ) : (
                  <div style={{display:"grid", gridTemplateColumns:"2fr 1fr 1.5fr 1fr 1fr 1fr auto",
                    gap:12, padding:"12px 16px", alignItems:"center", cursor:"pointer", transition:"background .1s"}}
                    onClick={()=>onSelect(p.id)}
                    onMouseEnter={e=>e.currentTarget.style.background=C.bgSubtle}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <div style={{display:"flex", gap:10, alignItems:"center", minWidth:0}}>
                      {p.lat && p.lng ? (
                        <div style={{width:38, height:38, borderRadius:C.r2, overflow:"hidden", flexShrink:0,
                          border:"1px solid "+C.border, background:C.bgSubtle}}>
                          <SafeImg src={svUrl(p.lat,p.lng,88,88)} fallback={imgPlaceholder(16)}
                            style={{width:"100%", height:"100%", objectFit:"cover"}} />
                        </div>
                      ) : (
                        <div style={{width:38, height:38, borderRadius:C.r2, background:C.bgSubtle,
                          display:"flex", alignItems:"center", justifyContent:"center", color:C.textMuted, flexShrink:0}}>
                          <I.building size={16}/>
                        </div>
                      )}
                      <div style={{minWidth:0}}>
                        <div style={{fontWeight:600, fontSize:13, color:C.text, fontFamily:F, letterSpacing:"-0.005em",
                          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{p.address}</div>
                        <div style={{fontSize:12, color:C.textSub, fontFamily:F, marginTop:1}}>{p.city}, {p.state} · {p.beds}bd {p.baths}ba</div>
                      </div>
                    </div>
                    <div style={{fontSize:13, color:C.textSub, fontFamily:F}}>{p.type}</div>
                    <div style={{fontSize:13, color:C.text, fontFamily:F,
                      overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{p.tenantName||"—"}</div>
                    <div style={{fontSize:13, fontWeight:600, color:cfC(m.chosenCF), fontFamily:F, fontVariantNumeric:"tabular-nums"}}>{$mo(m.chosenCF)}</div>
                    <div style={{fontSize:13, fontWeight:500, color:cfC(m.chosenCoC), fontFamily:F, fontVariantNumeric:"tabular-nums"}}>{pct(m.chosenCoC)}</div>
                    <Badge label={p.tenantStatus} bg={st.bg} c={st.c} dot/>
                    <button onClick={e=>{e.stopPropagation();if(window.confirm("Delete this property?"))onDelete(p.id);}}
                      {...btnStyle("ghost","sm", {color:C.textMuted, padding:"5px 6px"})} aria-label="Delete">
                      <I.trash size={14}/>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

// -- Property Detail -----------------------------------------------------------
function PropertyDetail({prop, onBack, onChange, onDelete, llcs, renoRates, mobile, apiLookup, rentcastKey, rcAuth}) {
  const [tab, setTab] = useState("overview");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState("");
  const m = calc(prop);
  const u = (f,v) => onChange({...prop, [f]:v});
  const tabs = [["overview","Overview"],["calculator","Calculator"],["tenant","Tenant"],["projects","Projects"],["expenses","Expenses"],["notes","Notes"]];

  // Open each property scrolled to the very top, not wherever the list was.
  useEffect(() => { window.scrollTo(0, 0); }, [prop.id]);

  // Re-pull public records for an existing property. applyRentcast only
  // overwrites public-record + valuation fields, so the user's ownership,
  // lockbox, purchase price, rent, tenant, projects and expenses are kept.
  const refreshData = async () => {
    if (!rcOk(rcAuth)) { setRefreshErr("Live property data is currently unavailable."); return; }
    setRefreshing(true); setRefreshErr("");
    try {
      const key = lookupKey("rc-detail", prop.address, prop.city, prop.state, prop.zip);
      const d = await apiLookup(key, () => rentcastFetch(prop.address, prop.city, prop.state, prop.zip, rcAuth));
      if (rcHasData(d)) onChange(applyRentcast(prop, d, renoRates));
      else setRefreshErr("No public records found for this address.");
    } catch (e) { setRefreshErr(e && e.code === "CAP" ? LOOKUP_CAP_MSG : "Refresh failed."); }
    setRefreshing(false);
  };

  return (
    <div style={{paddingBottom:mobile?100:40}}>
      {/* Sticky header. Mobile keeps the glassy translucent look; desktop
          uses a solid bg to avoid Safari's known backdrop-filter+sticky
          scroll-stutter bug. */}
      <div style={{
        background: mobile ? "rgba(255,255,255,.92)" : "#ffffff",
        borderBottom:"1px solid "+C.border,
        padding:mobile?"12px 16px":"14px 32px",
        position:"sticky",
        top: mobile ? "calc(env(safe-area-inset-top, 0px) + 54px)" : 56,
        zIndex:50,
        ...(mobile ? {
          backdropFilter:"saturate(180%) blur(10px)",
          WebkitBackdropFilter:"saturate(180%) blur(10px)",
        } : {}),
      }}>
        <div style={{display:"flex", alignItems:"center", gap:12, marginBottom:12}}>
          <button onClick={onBack}
            style={{background:C.card, border:"1px solid "+C.border, borderRadius:C.r2,
              width:34, height:34, cursor:"pointer", color:C.text,
              display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0,
              boxShadow:C.sh1}}>
            <I.arrowLeft size={16}/>
          </button>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontWeight:600, fontSize:mobile?15:17, color:C.text, fontFamily:F, letterSpacing:"-0.02em",
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{prop.address}</div>
            <div style={{fontSize:12, color:C.textSub, fontFamily:F, marginTop:1}}>{prop.city}, {prop.state}{prop.llc ? " · "+prop.llc : ""}</div>
          </div>
          <div style={{display:"flex", gap:8}}>
            <a href={"https://www.zillow.com/homes/"+encodeURIComponent(prop.address+" "+prop.city)+"_rb/"}
              target="_blank" rel="noreferrer"
              {...btnStyle("secondary","sm")}>Zillow <I.externalLink size={11} stroke={2.5}/></a>
            <button onClick={()=>{ if(window.confirm("Delete this property?")) onDelete(prop.id); }}
              {...btnStyle("danger","sm")} aria-label="Delete property">
              <I.trash size={13}/>
            </button>
          </div>
        </div>
        <div className="dh-tab-row" style={{display:"flex", overflowX:"auto", WebkitOverflowScrolling:"touch", scrollbarWidth:"none", gap:4}}>
          {tabs.map(([id,label]) => (
            <button key={id} onClick={()=>setTab(id)}
              style={{padding:"8px 0", marginRight:18, border:"none", background:"none", cursor:"pointer",
                fontSize:13, fontWeight:tab===id?600:500,
                color:tab===id?C.text:C.textMuted,
                borderBottom: tab===id ? "2px solid "+C.text : "2px solid transparent",
                fontFamily:F, whiteSpace:"nowrap", flexShrink:0,
                letterSpacing:"-0.005em",
                transition:"color .12s, border-color .12s"}}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{padding:mobile?"16px":"24px 32px"}}>
        {/* KPI strip */}
        <div style={{display:"grid", gridTemplateColumns:mobile?"1fr 1fr":"repeat(4,1fr)", gap:12, marginBottom:24}}>
          {[
            [`Cash Flow / mo (${prop.chosenStrategy==="cash"?"Cash":"Finance"})`, $mo(m.chosenCF), cfC(m.chosenCF)],
            ["Cash-on-cash", pct(m.chosenCoC), cfC(m.chosenCoC)],
            ["Cap rate", pct(m.chosenCap), C.text],
            ["Out of pocket", $(m.chosenOOP), C.text],
          ].map(([l,v,c]) => (
            <Card key={l} style={{padding:"14px 16px"}}>
              <div style={{fontSize:12, color:C.textSub, fontWeight:500, fontFamily:F}}>{l}</div>
              <div style={{fontSize:22, fontWeight:700, color:c, fontFamily:F, marginTop:6, fontVariantNumeric:"tabular-nums", letterSpacing:"-0.02em"}}>{v}</div>
            </Card>
          ))}
        </div>

        {tab==="overview" && (
          <div>
            <StreetViewImg lat={prop.lat} lng={prop.lng} address={prop.address} height={220} />
            <SectionBlock title="Property details" color={C.text} right={
              <button onClick={refreshData} disabled={refreshing} {...btnStyle("secondary","sm")}>
                <I.search size={12}/> {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            }>
              {refreshErr && (
                <div style={{display:"flex", gap:6, alignItems:"center", color:C.redDark, fontSize:12, marginBottom:12, fontFamily:F}}>
                  <I.alert size={13}/> {refreshErr}
                </div>
              )}
              <div style={{display:"grid", gridTemplateColumns:mobile?"minmax(0,1fr) minmax(0,1fr)":"repeat(3, minmax(0,1fr))", gap:mobile?10:14}}>
                <InputField label="Type" type="text" val={prop.type||""} set={v=>u("type",v)} mobile={mobile} />
                <InputField label="Beds" val={prop.beds||0} set={v=>u("beds",v)} mobile={mobile} />
                <InputField label="Baths" val={prop.baths||0} set={v=>u("baths",v)} mobile={mobile} />
                <InputField label="Sq ft" val={prop.sqft||0} set={v=>u("sqft",v)} mobile={mobile} />
                <InputField label="Year built" type="text" val={prop.yearBuilt||""} set={v=>u("yearBuilt",v)} mobile={mobile} />
                <InputField label="Tax value" val={prop.taxValue||0} set={v=>u("taxValue",v)} pre="$" mobile={mobile} />
                <InputField label="Lockbox" type="text" val={prop.lockboxCode||""} set={v=>u("lockboxCode",v)} mobile={mobile} />
                <InputField label="Parcel ID" type="text" val={prop.parcelId||""} set={v=>u("parcelId",v)} mobile={mobile} />
                <div style={{marginBottom:14}}>
                  <label style={{fontSize:13, color:C.text, fontWeight:500, display:"block", marginBottom:6, fontFamily:F}}>Ownership</label>
                  <input value={prop.llc||""} onChange={e=>u("llc",e.target.value)} list="dh-llcs"
                    placeholder="Which LLC owns this?" style={iS(mobile)} />
                  <datalist id="dh-llcs">{(llcs||[]).map(l => <option key={l} value={l}/>)}</datalist>
                </div>
              </div>
            </SectionBlock>
            <div style={{display:"grid", gridTemplateColumns:mobile?"1fr":"1fr 1fr", gap:10, marginBottom:14}}>
              <a href={"https://maps.google.com/?q="+encodeURIComponent(prop.address+" "+prop.city)}
                target="_blank" rel="noreferrer"
                {...btnStyle("secondary","md")}><I.pin size={14}/> Open in Google Maps</a>
              <a href={"https://www.zillow.com/homes/"+encodeURIComponent(prop.address+" "+prop.city)+"_rb/"}
                target="_blank" rel="noreferrer"
                {...btnStyle("secondary","md")}>View on Zillow <I.externalLink size={13}/></a>
            </div>
          </div>
        )}
        {tab==="calculator" && <Calculator p={prop} set={onChange} renoRates={renoRates} mobile={mobile} apiLookup={apiLookup} rentcastKey={rentcastKey} rcAuth={rcAuth} stickyTop="calc(env(safe-area-inset-top, 0px) + 166px)" />}
        {tab==="tenant"     && <TenantSection p={prop} set={onChange} mobile={mobile} />}
        {tab==="projects"   && <PropertyProjectsTab p={prop} set={onChange} mobile={mobile} />}
        {tab==="expenses"   && <ExpensesTab p={prop} set={onChange} mobile={mobile} />}
        {tab==="notes"      && (
          <SectionBlock title="Notes" color={C.sidebar} icon={I.edit}>
            <textarea value={prop.notes||""} onChange={e=>u("notes",e.target.value)}
              placeholder="Lockbox codes, quit claim, lead safe, legal notes…"
              style={{...iS(mobile), minHeight:220, resize:"vertical", lineHeight:1.55}} />
          </SectionBlock>
        )}
      </div>
    </div>
  );
}

// -- Tenant Section ------------------------------------------------------------
function TenantSection({p, set, mobile}) {
  const u = (f,v) => set({...p,[f]:v}), days = dU(p.leaseEnd);
  return (
    <div>
      {p.tenantPhone && (
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14}}>
          <a href={"tel:"+p.tenantPhone} {...btnStyle("primary","md")}><I.phone size={14}/> Call</a>
          <a href={"sms:"+p.tenantPhone} {...btnStyle("secondary","md")}><I.message size={14}/> Text</a>
        </div>
      )}
      {days!==null && days<=60 && days>=0 && (
        <Banner tone="warn" icon={<I.alert size={14}/>}>
          Lease expires in <b style={{fontWeight:600}}>{days} day{days===1?"":"s"}</b> — follow up about renewal.
        </Banner>
      )}
      {days!==null && days<0 && (
        <Banner tone="danger" icon={<I.alert size={14}/>}>
          Lease expired <b style={{fontWeight:700}}>{Math.abs(days)} day{Math.abs(days)===1?"":"s"}</b> ago.
        </Banner>
      )}
      <SectionBlock title="Tenant" color={C.green}>
        <div style={{display:"grid", gridTemplateColumns:mobile?"1fr":"1fr 1fr", gap:12}}>
          <InputField label="Tenant name" val={p.tenantName||""} set={v=>u("tenantName",v)} type="text" mobile={mobile} />
          <InputField label="Phone" val={p.tenantPhone||""} set={v=>u("tenantPhone",v)} type="text" mobile={mobile} />
          <InputField label="Email" val={p.tenantEmail||""} set={v=>u("tenantEmail",v)} type="text" mobile={mobile} />
          <InputField label="Security deposit" val={p.rentDeposit||0} set={v=>u("rentDeposit",v)} pre="$" mobile={mobile} />
          <DateField label="Lease start" value={p.leaseStart||""} onChange={v=>u("leaseStart",v)} mobile={mobile}/>
          <DateField label="Lease end" value={p.leaseEnd||""} onChange={v=>u("leaseEnd",v)} mobile={mobile}/>
          <SelectField label="Payment status" value={p.tenantStatus} onChange={v=>u("tenantStatus",v)} options={["Current","Late","Partial","Vacant"]} mobile={mobile}/>
          <SelectField label="Occupancy" value={p.occupied?"Occupied":"Vacant"} onChange={v=>u("occupied",v==="Occupied")} options={["Occupied","Vacant"]} mobile={mobile}/>
        </div>
      </SectionBlock>
    </div>
  );
}

function Banner({tone="info", icon, children}) {
  const palette = {
    info:   {bg:C.blueSubtle,   border:C.blueBorder,   text:C.blueDark},
    warn:   {bg:C.amberSubtle,  border:C.amberBorder,  text:C.amberDark},
    danger: {bg:C.redSubtle,    border:C.redBorder,    text:C.redDark},
    success:{bg:C.greenSubtle,  border:C.greenBorder,  text:C.greenDark},
  }[tone] || {bg:C.bgSubtle, border:C.border, text:C.text};
  return (
    <div style={{
      display:"flex", gap:10, alignItems:"flex-start",
      background:palette.bg, border:"1px solid "+palette.border,
      borderRadius:C.r3, padding:"11px 14px", marginBottom:14,
      fontSize:13, color:palette.text, fontFamily:F, lineHeight:1.55,
    }}>
      {icon && <span style={{flexShrink:0, marginTop:1}}>{icon}</span>}
      <div style={{flex:1}}>{children}</div>
    </div>
  );
}

function DateField({label, value, onChange, mobile}) {
  return (
    <div style={{marginBottom:14}}>
      <label style={{fontSize:13, color:C.text, fontWeight:500, display:"block", marginBottom:6, fontFamily:F}}>{label}</label>
      <input type="date" value={value} onChange={e=>onChange(e.target.value)} style={iS(mobile)} />
    </div>
  );
}

function SelectField({label, value, onChange, options, mobile}) {
  return (
    <div style={{marginBottom:14}}>
      <label style={{fontSize:13, color:C.text, fontWeight:500, display:"block", marginBottom:6, fontFamily:F}}>{label}</label>
      <select value={value} onChange={e=>onChange(e.target.value)} style={iS(mobile)}>
        {options.map(o => {
          const [v, l] = Array.isArray(o) ? o : [o, o];
          return <option key={v} value={v}>{l}</option>;
        })}
      </select>
    </div>
  );
}

// -- Property Projects Tab -----------------------------------------------------
// Per-property view of follow-ups. Reuses the same PropertySection rows + quick
// add form that the cross-property Projects page uses, so adding/editing/marking
// done from either place writes to the same projects array on the property.
// -- Projects (follow-ups) -----------------------------------------------------
// Cross-property workspace for capturing quick follow-up items during a
// contractor call. Reuses the existing `projects` array on each property and
// extends each entry with: type, dueDate, priority, contractor, log, photos.

const startOfToday = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };

// Display a YYYY-MM-DD date as something humans want to read.
const formatDue = (iso) => {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  const today = startOfToday();
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff < 0) return `${-diff} days ago`;
  if (diff < 7) return d.toLocaleDateString(undefined, {weekday:"short"});
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? {month:"short", day:"numeric"} : {month:"short", day:"numeric", year:"numeric"});
};

// Add 1 day to an ISO date (or "today" if none), return YYYY-MM-DD.
const nextDayIso = (iso) => {
  const base = iso ? new Date(iso + "T00:00:00") : startOfToday();
  base.setDate(base.getDate() + 1);
  const y = base.getFullYear(), m = String(base.getMonth()+1).padStart(2,"0"), d = String(base.getDate()).padStart(2,"0");
  return `${y}-${m}-${d}`;
};
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};

// "5m ago" / "3h ago" / "2d ago" — used by the Deals page "last updated" stamp.
const timeAgo = (ts) => {
  if (!ts) return "";
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60)        return `${s}s ago`;
  if (s < 3600)      return `${Math.round(s/60)}m ago`;
  if (s < 86400)     return `${Math.round(s/3600)}h ago`;
  return `${Math.round(s/86400)}d ago`;
};

// -- Activity timeline helpers -------------------------------------------------
// Day divider label: "Today" / "Yesterday" / "Monday" / "May 21" / "May 21, 2024".
const dayHeader = (d) => {
  if (!d) return "Earlier";
  const today = startOfToday();
  const that  = new Date(d); that.setHours(0,0,0,0);
  const diff  = Math.round((that - today) / 86400000);
  if (diff === 0)  return "Today";
  if (diff === -1) return "Yesterday";
  if (diff > -7 && diff < 0) return d.toLocaleDateString("en-US", {weekday:"long"});
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", sameYear ? {month:"short", day:"numeric"} : {month:"short", day:"numeric", year:"numeric"});
};

// "2:14 PM" — used as the per-entry timestamp on the right of each item.
const timeOf = (d) => d.toLocaleTimeString("en-US", {hour:"numeric", minute:"2-digit", hour12:true});

// Append system events to pr.log when tracked fields change. Currently logs
// status flips (Open ↔ Done) and due-date moves. Other field edits pass through
// silently — they're considered live metadata, not narrative-worthy.
const withEvents = (pr, changes) => {
  const events = [];
  const ts = new Date().toISOString();
  if (changes.status !== undefined) {
    const before = pr.status || "In Progress";
    if (changes.status !== before) events.push({ts, kind:"event", event:"status", from:before, to:changes.status});
  }
  if (changes.dueDate !== undefined && (changes.dueDate || "") !== (pr.dueDate || "")) {
    events.push({ts, kind:"event", event:"due", from: pr.dueDate || "", to: changes.dueDate || ""});
  }
  return events.length
    ? {...pr, ...changes, log: [...(pr.log || []), ...events]}
    : {...pr, ...changes};
};

// Normalize a follow-up's notes + events into a flat, dated entries list.
// Supports three historical shapes for backward compat:
//   - {ts, kind:"note", body}        (canonical)
//   - {ts, kind:"event", event,…}    (canonical)
//   - {ts, note}                     (older notes, no kind)
//   - {date:"May 21, 2:14 PM", note} (oldest notes, no ts → "Earlier" bucket)
// pr.details (legacy single description) is surfaced as the first entry.
const buildTimeline = (pr) => {
  const out = [];
  if (pr.details) out.push({key:"details", kind:"note", body:pr.details, date:null, isDetails:true});
  (pr.log || []).forEach((n, i) => {
    const d = n.ts ? new Date(n.ts) : null;
    if (n.kind === "event") {
      out.push({key:`log-${i}`, kind:"event", event:n.event, from:n.from, to:n.to, date:d, idx:i});
    } else {
      out.push({key:`log-${i}`, kind:"note", body: n.body || n.note || "", date:d, idx:i});
    }
  });
  return out;
};

// Group timeline entries by calendar day, newest day first, newest entry first within a day.
const groupTimelineByDay = (entries) => {
  const buckets = new Map();
  for (const e of entries) {
    const key = e.date
      ? `${e.date.getFullYear()}-${e.date.getMonth()}-${e.date.getDate()}`
      : "earlier";
    if (!buckets.has(key)) buckets.set(key, {date:e.date, entries:[]});
    buckets.get(key).entries.push(e);
  }
  const arr = [...buckets.values()];
  arr.sort((a, b) => (b.date ? b.date.getTime() : -1) - (a.date ? a.date.getTime() : -1));
  arr.forEach(b => b.entries.sort((a, b) => (b.date ? b.date.getTime() : -1) - (a.date ? a.date.getTime() : -1)));
  return arr;
};

// Inline rich text: **bold**, *italic*, `code`, plus auto-linked http(s) URLs.
const renderRich = (text) => {
  if (!text) return null;
  const out = [];
  String(text).split("\n").forEach((line, li) => {
    if (li > 0) out.push(<br key={`br-${li}`} />);
    const re = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|https?:\/\/[^\s)]+)/g;
    let last = 0, m, idx = 0;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) out.push(line.slice(last, m.index));
      const tok = m[0], k = `${li}-${idx++}`;
      if (tok.startsWith("**"))      out.push(<strong key={k} style={{fontWeight:700}}>{tok.slice(2,-2)}</strong>);
      else if (tok.startsWith("`"))  out.push(<code   key={k} style={{fontFamily:'"JetBrains Mono", ui-monospace, monospace', fontSize:"0.92em", background:C.bgSubtle, padding:"1px 5px", borderRadius:4}}>{tok.slice(1,-1)}</code>);
      else if (tok.startsWith("*"))  out.push(<em     key={k} style={{fontStyle:"italic"}}>{tok.slice(1,-1)}</em>);
      else                           out.push(<a      key={k} href={tok} target="_blank" rel="noreferrer" style={{color:C.blue, textDecoration:"none", borderBottom:"1px solid "+C.blueBorder}}>{tok}</a>);
      last = m.index + tok.length;
    }
    if (last < line.length) out.push(line.slice(last));
  });
  return out;
};

// Markdown → HTML, used to seed a contentEditable editor from stored markdown.
// Renders the same subset as `renderRich`: **bold**, *italic*, `code`, auto-linked URLs.
const mdToHtml = (md) => {
  if (!md) return "";
  return String(md)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\n/g, "<br>");
};

// HTML → markdown for storage. Walks the DOM and emits a small markdown subset.
// Anything outside the allowlist is reduced to its text content, so pasted rich
// content can never sneak unsafe tags into the saved note.
const htmlToMd = (html) => {
  if (!html) return "";
  const root = document.createElement("div");
  root.innerHTML = html;
  let out = "";
  const walk = (node) => {
    if (node.nodeType === 3) { out += node.textContent; return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "br") { out += "\n"; return; }
    if (tag === "div" || tag === "p") {
      if (out && !out.endsWith("\n")) out += "\n";
      [...node.childNodes].forEach(walk);
      if (!out.endsWith("\n")) out += "\n";
      return;
    }
    if (tag === "strong" || tag === "b") { out += "**"; [...node.childNodes].forEach(walk); out += "**"; return; }
    if (tag === "em" || tag === "i")     { out += "*";  [...node.childNodes].forEach(walk); out += "*";  return; }
    if (tag === "code")                  { out += "`";  [...node.childNodes].forEach(walk); out += "`";  return; }
    [...node.childNodes].forEach(walk);  // <a>, unknown tags → just text (URLs are auto-linked on render)
  };
  [...root.childNodes].forEach(walk);
  return out.replace(/\n{3,}/g, "\n\n").trim();
};

// Human description of a system event for inline rendering in the timeline.
const describeEvent = (e) => {
  if (e.event === "status") {
    return e.to === "Complete"
      ? {label:"Marked done", tone:"success"}
      : {label:"Reopened",    tone:"muted"};
  }
  if (e.event === "due") {
    if (!e.from && e.to) return {label:"Due " + formatDue(e.to),           tone:"muted"};
    if (e.from && !e.to) return {label:"Due date cleared",                  tone:"muted"};
    return                     {label:"Due moved to " + formatDue(e.to),    tone:"muted"};
  }
  return {label:"Updated", tone:"muted"};
};

// Resize an uploaded image to maxWidth and return a JPEG data URL.
const resizeImageToDataUrl = (file, maxWidth=800, quality=0.82) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const w = Math.min(maxWidth, img.width);
      const h = Math.round(w * (img.height / img.width));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      try { resolve(canvas.toDataURL("image/jpeg", quality)); } catch (err) { reject(err); }
    };
    img.onerror = reject;
    img.src = e.target.result;
  };
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

// 4-up aspect-square photo grid with inline upload.
function PhotoUploader({photos=[], onChange}) {
  const [uploading, setUploading] = useState(false);
  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file, 800, 0.82);
      onChange([...(photos||[]), dataUrl]);
    } catch {}
    setUploading(false);
    e.target.value = "";
  };
  return (
    <div style={{marginBottom:14}}>
      <label style={{fontSize:13, color:C.text, fontWeight:500, display:"block", marginBottom:6, fontFamily:F}}>Photos</label>
      <div style={{display:"grid", gridTemplateColumns:"repeat(4, 1fr)", gap:8}}>
        {photos.map((src, i) => (
          <div key={i} style={{position:"relative", aspectRatio:"1/1", borderRadius:C.r2, overflow:"hidden",
            border:"1px solid "+C.border, background:C.bgSubtle}}>
            <img src={src} alt="" style={{width:"100%", height:"100%", objectFit:"cover", display:"block"}} />
            <button onClick={()=>onChange(photos.filter((_,j)=>j!==i))}
              aria-label="Remove photo"
              style={{position:"absolute", top:4, right:4, width:20, height:20, borderRadius:"50%",
                background:"rgba(9,9,11,.75)", color:"white", border:"none", cursor:"pointer",
                display:"flex", alignItems:"center", justifyContent:"center", padding:0}}>
              <I.x size={11} stroke={3}/>
            </button>
          </div>
        ))}
        {photos.length < 4 && (
          <label style={{
            aspectRatio:"1/1", borderRadius:C.r2, border:"1px dashed "+C.borderHover,
            display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
            gap:4, cursor:"pointer", color:C.textMuted, fontSize:11, fontFamily:F, fontWeight:500,
            transition:"border-color .12s, color .12s, background .12s",
            opacity: uploading ? .6 : 1,
          }}
          onMouseEnter={e=>{e.currentTarget.style.borderColor=C.green; e.currentTarget.style.color=C.green; e.currentTarget.style.background=C.greenSubtle;}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor=C.borderHover; e.currentTarget.style.color=C.textMuted; e.currentTarget.style.background="transparent";}}>
            {uploading ? <span style={{fontSize:11}}>…</span> : <I.camera size={20}/>}
            <span>{uploading ? "Uploading" : "Add"}</span>
            <input type="file" accept="image/*" capture="environment" onChange={handleFile}
              disabled={uploading} style={{display:"none"}} />
          </label>
        )}
      </div>
    </div>
  );
}

// PDF / document attachments. Stored as base64 data URLs on the follow-up.
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4MB cap (data lives in the Firebase blob)
function FileUploader({files=[], onChange, mobile}) {
  const [err, setErr] = useState("");
  const handleFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { setErr(`"${file.name}" is over 4 MB — too large to attach.`); return; }
    setErr("");
    const reader = new FileReader();
    reader.onload = (ev) => onChange([...(files||[]), {name:file.name, dataUrl:ev.target.result}]);
    reader.readAsDataURL(file);
  };
  return (
    <div style={{marginBottom:14}}>
      <label style={{fontSize:13, color:C.text, fontWeight:500, display:"block", marginBottom:6, fontFamily:F}}>Documents (PDF)</label>
      {files.map((f, i) => (
        <div key={i} style={{display:"flex", alignItems:"center", gap:10, padding:"8px 10px",
          background:C.card, border:"1px solid "+C.border, borderRadius:C.r2, marginBottom:6}}>
          <div style={{width:26, height:26, borderRadius:C.r1, background:C.redSubtle, color:C.redDark,
            display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:9, fontWeight:700, fontFamily:F}}>PDF</div>
          <a href={f.dataUrl} target="_blank" rel="noreferrer" download={f.name}
            style={{flex:1, minWidth:0, fontSize:13, color:C.text, fontFamily:F, fontWeight:500,
              textDecoration:"none", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
            {f.name}
          </a>
          <a href={f.dataUrl} target="_blank" rel="noreferrer"
            {...btnStyle("ghost","sm", {color:C.textSub, padding:"4px 8px"})}><I.externalLink size={13}/></a>
          <button onClick={()=>onChange(files.filter((_,j)=>j!==i))} aria-label="Remove file"
            {...btnStyle("ghost","sm", {color:C.textMuted, padding:"4px 7px"})}><I.trash size={13}/></button>
        </div>
      ))}
      <label {...btnStyle("secondary","sm")} style={{...btnStyle("secondary","sm").style, cursor:"pointer"}}>
        <I.plus size={13}/> Attach PDF
        <input type="file" accept="application/pdf" onChange={handleFile} style={{display:"none"}} />
      </label>
      {err && <div style={{fontSize:12, color:C.redDark, fontFamily:F, marginTop:6}}>{err}</div>}
    </div>
  );
}

// Activity timeline: clean Linear-style feed of notes + system events.
// Composer pinned at top, day dividers inline, newest-first ordering.
// `pr.log` entries are either {ts, kind:"note", body} or
// {ts, kind:"event", event, from, to}. Legacy {ts, note} and pr.details are
// also rendered via buildTimeline().
// WYSIWYG rich editor backed by contentEditable. Stores markdown in the data
// model (so renderRich() keeps working for both new and legacy notes), but the
// user only ever sees real bold/italic — no asterisks leaking into the UI.
function RichEditor({initialMd = "", placeholder = "", onSubmit, onCancel,
                     autoFocus = false, primary = "Add note", showCancel = false,
                     minHeight = 48, mobile}) {
  const ref = useRef(null);
  const [empty, setEmpty] = useState(true);

  // Seed content once and focus with the caret at the end. Setting innerHTML
  // on every render would clobber the user's selection mid-typing, so we
  // intentionally only do it on mount.
  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = mdToHtml(initialMd);
    setEmpty(!ref.current.textContent.trim());
    if (autoFocus) {
      ref.current.focus();
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshEmpty = () => setEmpty(!ref.current.textContent.trim());

  const submit = () => {
    if (!ref.current) return;
    const md = htmlToMd(ref.current.innerHTML);
    if (!md.trim()) return;
    onSubmit(md);
    ref.current.innerHTML = "";
    setEmpty(true);
  };

  const fmt = (cmd) => {
    if (!ref.current) return;
    ref.current.focus();
    // execCommand is deprecated but is the only cross-browser way to toggle
    // bold/italic at the current selection. The Selection API equivalent would
    // be ~50 lines of edge-case handling. Pragmatic choice for now.
    document.execCommand(cmd, false, null);
    refreshEmpty();
  };

  const fmtBtn = (label, title, onClick, style={}) => (
    <button type="button" onMouseDown={e => { e.preventDefault(); onClick(); }}
      title={title} aria-label={title}
      style={{
        width:28, height:28, borderRadius:C.r1, border:"1px solid "+C.border,
        background:C.card, color:C.textSub, fontFamily:F, fontWeight:600,
        fontSize:13, cursor:"pointer", lineHeight:1, flexShrink:0,
        display:"inline-flex", alignItems:"center", justifyContent:"center",
        transition:"background .12s, color .12s, border-color .12s",
        ...style,
      }}>{label}</button>
  );

  return (
    <div className="dh-tl-composer" style={{
      border:"1px solid "+C.border, borderRadius:C.r3, background:C.card,
      padding:"10px 12px 8px",
      transition:"border-color .15s, box-shadow .15s",
    }}>
      <div ref={ref}
        contentEditable
        suppressContentEditableWarning
        className="dh-rich-editor"
        data-placeholder={placeholder}
        data-empty={empty ? "true" : "false"}
        onInput={refreshEmpty}
        onPaste={e => {
          // Strip any rich formatting from pasted content — only plain text
          // gets into the editor. Keeps the storage layer simple and prevents
          // pasted HTML from sneaking in unexpected tags/styles.
          e.preventDefault();
          const text = (e.clipboardData || window.clipboardData).getData("text/plain");
          document.execCommand("insertText", false, text);
        }}
        onKeyDown={e => {
          if ((e.metaKey||e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
          if (e.key === "Escape" && onCancel) { e.preventDefault(); onCancel(); }
        }}
        style={{
          minHeight, outline:"none",
          fontFamily:F, fontSize:14, color:C.text, lineHeight:1.55,
          whiteSpace:"pre-wrap", wordBreak:"break-word",
        }} />
      <div style={{display:"flex", gap:6, marginTop:8, alignItems:"center"}}>
        {fmtBtn("B", "Bold (⌘B)",   () => fmt("bold"),   {fontWeight:700})}
        {fmtBtn("I", "Italic (⌘I)", () => fmt("italic"), {fontStyle:"italic", fontFamily:"Georgia, serif"})}
        <span style={{flex:1}} />
        {!mobile && !showCancel && (
          <span style={{fontSize:11, color:C.textMuted, fontFamily:F}}>⌘↵ to save</span>
        )}
        {showCancel && (
          <button onClick={onCancel} {...btnStyle("ghost","sm")}>Cancel</button>
        )}
        <button onClick={submit} disabled={empty}
          {...btnStyle("primary","sm", empty ? {opacity:.45, cursor:"not-allowed"} : {})}>
          {!showCancel && <I.plus size={12}/>}{primary}
        </button>
      </div>
    </div>
  );
}

function ActivityTimeline({pr, onChange, mobile}) {
  const [editKey, setEditKey] = useState(null);

  const days = groupTimelineByDay(buildTimeline(pr));
  const isEmpty = days.length === 0 || (days.length === 1 && days[0].entries.length === 0);

  const addNote = (md) => {
    onChange({...pr, log: [...(pr.log || []), {ts: new Date().toISOString(), kind:"note", body: md}]});
  };
  const commitEdit = (entry, md) => {
    if (entry.isDetails) {
      onChange({...pr, details: md});
    } else {
      onChange({...pr, log: (pr.log || []).map((n, i) => i === entry.idx
        ? {...n, kind:"note", body: md, note: undefined}
        : n)});
    }
    setEditKey(null);
  };
  const deleteEntry = (entry) => {
    if (entry.isDetails) onChange({...pr, details: ""});
    else onChange({...pr, log: (pr.log || []).filter((_, i) => i !== entry.idx)});
    setEditKey(null);
  };

  // Render a single user-written note.
  const renderNote = (entry) => {
    const editing = editKey === entry.key;
    return (
      <div key={entry.key} className="dh-tl-item" style={{position:"relative", padding:"10px 0"}}>
        <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:4}}>
          <span style={{fontSize:11, color:C.textMuted, fontFamily:F, fontVariantNumeric:"tabular-nums",
            fontWeight:500, flexShrink:0}}>
            {entry.date ? timeOf(entry.date) : "Note"}
          </span>
          {!editing && (
            <span className="dh-tl-actions" style={{display:"inline-flex", gap:2}}>
              <button onClick={()=>setEditKey(entry.key)} aria-label="Edit"
                className="dh-tl-action" title="Edit">
                <I.edit size={12}/>
              </button>
              <button onClick={()=>deleteEntry(entry)} aria-label="Delete"
                className="dh-tl-action" title="Delete">
                <I.trash size={12}/>
              </button>
            </span>
          )}
        </div>
        {editing ? (
          <RichEditor
            key={entry.key + "-edit"}
            initialMd={entry.body || ""}
            placeholder="Note…"
            onSubmit={(md) => commitEdit(entry, md)}
            onCancel={() => setEditKey(null)}
            primary="Save"
            showCancel
            autoFocus
            mobile={mobile} />
        ) : (
          <div style={{
            fontSize:14, color:C.text, fontFamily:F, lineHeight:1.6,
            whiteSpace:"pre-wrap", wordBreak:"break-word",
          }}>
            {renderRich(entry.body)}
          </div>
        )}
      </div>
    );
  };

  // System event (status change, due-date move) — light one-line row.
  const renderEvent = (entry) => {
    const e = describeEvent(entry);
    const tone = e.tone === "success"
      ? {bg: C.greenSubtle, border: C.greenBorder, icon: C.greenDark}
      : {bg: C.bgSubtle,    border: C.border,      icon: C.textMuted};
    const Icon = entry.event === "status" && entry.to === "Complete" ? I.check : I.clock;
    return (
      <div key={entry.key} style={{
        display:"flex", alignItems:"center", gap:10, padding:"7px 0",
        fontSize:13, fontFamily:F,
      }}>
        <span style={{
          width:20, height:20, borderRadius:"50%", flexShrink:0,
          background: tone.bg, border:"1px solid "+tone.border, color: tone.icon,
          display:"inline-flex", alignItems:"center", justifyContent:"center",
        }}>
          <Icon size={11} stroke={2.5}/>
        </span>
        <span style={{color:C.textSub, fontWeight:500, letterSpacing:"-0.005em"}}>
          {e.label}
        </span>
        <span style={{flex:1}} />
        <span style={{fontSize:11, color:C.textMuted, fontVariantNumeric:"tabular-nums",
          fontWeight:500, flexShrink:0}}>
          {entry.date ? timeOf(entry.date) : ""}
        </span>
      </div>
    );
  };

  return (
    <div style={{marginBottom:14}}>
      <div style={{display:"flex", alignItems:"center", gap:10, marginBottom:10}}>
        <span style={{fontSize:11, fontWeight:700, color:C.textSub, fontFamily:F,
          letterSpacing:".06em", textTransform:"uppercase"}}>Activity</span>
        <span style={{flex:1, height:1, background:C.border}}/>
      </div>

      <div style={{marginBottom:16}}>
        <RichEditor placeholder="Add a note…" onSubmit={addNote} mobile={mobile} />
      </div>

      {isEmpty && (
        <div style={{
          padding:"28px 16px", textAlign:"center",
          border:"1px dashed "+C.border, borderRadius:C.r3, background:C.bgSubtle,
        }}>
          <div style={{
            width:36, height:36, borderRadius:"50%", background:C.card,
            border:"1px solid "+C.border, color:C.textMuted,
            display:"inline-flex", alignItems:"center", justifyContent:"center", marginBottom:10,
          }}>
            <I.messageSquare size={16}/>
          </div>
          <div style={{fontSize:13, fontWeight:500, color:C.textSub, fontFamily:F}}>
            No activity yet
          </div>
          <div style={{fontSize:12, color:C.textMuted, fontFamily:F, marginTop:3}}>
            Track every call, decision, and follow-up here.
          </div>
        </div>
      )}

      {!isEmpty && days.map(day => (
        <div key={day.date ? day.date.getTime() : "earlier"} style={{marginBottom:8}}>
          <div style={{
            fontSize:11, fontWeight:700, color:C.textMuted, fontFamily:F,
            letterSpacing:".06em", textTransform:"uppercase",
            marginTop:6, marginBottom:2,
          }}>
            {dayHeader(day.date)}
          </div>
          <div>
            {day.entries.map(entry => entry.kind === "event"
              ? renderEvent(entry)
              : renderNote(entry))}
          </div>
        </div>
      ))}
    </div>
  );
}

function FollowupExpanded({pr, onChange, onDelete, mobile, contractors=[], onAddExpense, isExpensed}) {
  // Field edits log a system event for tracked fields (status, dueDate); other
  // fields pass through quietly. Status isn't edited here — it's owned by the
  // done circle on the row — but dueDate is, so we go through withEvents.
  const u = (f, v) => onChange(withEvents(pr, {[f]: v}));
  const addExpense = () => {
    if (!onAddExpense) return;
    onAddExpense({
      id: "ex" + Date.now(),
      description: pr.name || "Follow-up",
      amount: pr.budget || 0,
      date: pr.dueDate || todayIso(),
      category: typeOf(pr),
      contractor: pr.contractor || "",
      fromFollowup: pr.id,
      createdAt: new Date().toISOString(),
    });
  };
  const sectionLabel = (text) => (
    <div style={{display:"flex", alignItems:"center", gap:10, marginBottom:12}}>
      <span style={{fontSize:11, fontWeight:700, color:C.textSub, fontFamily:F,
        letterSpacing:".06em", textTransform:"uppercase"}}>{text}</span>
      <span style={{flex:1, height:1, background:C.border}}/>
    </div>
  );
  const labelStyle = {fontSize:13, color:C.text, fontWeight:500, display:"block", marginBottom:6, fontFamily:F};

  return (
    <div style={{padding: mobile ? "18px 14px 16px" : "22px 24px 20px", background:C.card, borderTop:"1px solid "+C.border}}>
      {sectionLabel("Details")}
      <InputField label="What needs doing" type="text" val={pr.name||""} set={v=>u("name",v)} mobile={mobile} />
      <div style={{marginBottom:14}}>
        <label style={labelStyle}>Type</label>
        <TypePicker value={typeOf(pr)} onChange={v=>u("type",v)} />
      </div>
      <div style={{display:"grid", gridTemplateColumns: mobile ? "minmax(0,1fr)" : "repeat(4, minmax(0,1fr))", gap: mobile?10:12}}>
        <DateField label="Due date" value={pr.dueDate||""} onChange={v=>u("dueDate",v)} mobile={mobile} />
        <InputField label="Cost" val={pr.budget||0} set={v=>u("budget",v)} pre="$" mobile={mobile} />
        <SelectField label="Priority" value={pr.priority||"normal"} onChange={v=>u("priority",v)}
          options={[["high","High"],["normal","Normal"],["low","Low"]]} mobile={mobile} />
        <div style={{marginBottom:14}}>
          <label style={labelStyle}>Contractor</label>
          <input value={pr.contractor||""} onChange={e=>u("contractor", e.target.value)}
            list="dh-contractors" placeholder="Name" style={iS(mobile)} />
        </div>
      </div>

      <div style={{marginTop:mobile?18:24}}>
        <ActivityTimeline pr={pr} onChange={onChange} mobile={mobile} />
      </div>

      <div style={{marginTop:mobile?18:24}}>
        {sectionLabel("Attachments")}
        <PhotoUploader photos={pr.photos||[]} onChange={v=>u("photos",v)} />
        <FileUploader files={pr.files||[]} onChange={v=>u("files",v)} mobile={mobile} />
      </div>

      {onAddExpense && (
        <div style={{display:"flex", alignItems:"center", gap:10, padding:"12px 14px", marginTop:4, marginBottom:14,
          background:C.greenSubtle, border:"1px solid "+C.greenBorder, borderRadius:C.r3}}>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:13, fontWeight:600, color:C.text, fontFamily:F}}>Record this as an expense</div>
            <div style={{fontSize:12, color:C.textSub, fontFamily:F, marginTop:1}}>
              {pr.budget>0 ? `${$(pr.budget)} → Expenses tab` : "Add a cost above, then log it to Expenses"}
            </div>
          </div>
          {isExpensed ? (
            <span style={{display:"inline-flex", alignItems:"center", gap:5, fontSize:12, fontWeight:600,
              color:C.greenDark, fontFamily:F, flexShrink:0}}>
              <I.check size={14} stroke={2.5}/> In expenses
            </span>
          ) : (
            <button onClick={addExpense} disabled={!(pr.budget>0)}
              {...btnStyle("primary","sm", (pr.budget>0)?{}:{opacity:.45, cursor:"not-allowed"})}>
              <I.plus size={13}/> Add as expense
            </button>
          )}
        </div>
      )}

      <div style={{display:"flex", justifyContent:"flex-end", borderTop:"1px solid "+C.border, paddingTop:12, marginTop:4}}>
        <button onClick={onDelete}
          style={{background:"none", border:"none", padding:"6px 10px", borderRadius:C.r1,
            color:C.textMuted, fontFamily:F, fontSize:12, fontWeight:500, cursor:"pointer",
            display:"inline-flex", alignItems:"center", gap:6, transition:"color .12s, background .12s"}}
          onMouseEnter={e=>{e.currentTarget.style.color=C.redDark; e.currentTarget.style.background=C.redSubtle;}}
          onMouseLeave={e=>{e.currentTarget.style.color=C.textMuted; e.currentTarget.style.background="none";}}>
          <I.trash size={12}/> Delete follow-up
        </button>
      </div>
      {contractors.length > 0 && (
        <datalist id="dh-contractors">
          {contractors.map(c => <option key={c} value={c}/>)}
        </datalist>
      )}
    </div>
  );
}

function RowAction({icon, label, onClick, color}) {
  return (
    <button onClick={(e)=>{e.stopPropagation(); onClick(e);}}
      aria-label={label} title={label}
      className="dh-row-action"
      style={color ? {color} : undefined}>
      {icon}
    </button>
  );
}

function FollowupRow({pr, propLabel, propId, showProperty=false, onPropertyClick,
                      onChange, onDelete, mobile, contractors=[], onAddExpense, isExpensed}) {
  const [expanded, setExpanded] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const isDone    = pr.status === "Complete";
  const isOverdue = !isDone && pr.dueDate && new Date(pr.dueDate+"T00:00:00") < startOfToday();
  const isHigh    = pr.priority === "high";

  const toggleDone = (e) => {
    e && e.stopPropagation();
    onChange(withEvents(pr, {status: isDone ? "In Progress" : "Complete"}));
  };
  const snooze = () => onChange(withEvents(pr, {dueDate: nextDayIso(pr.dueDate)}));
  const openNoteBar = () => {
    if (expanded) { setExpanded(false); }
    setNoteOpen(true);
  };
  const submitInlineNote = () => {
    const v = noteText.trim();
    if (!v) return;
    onChange({...pr, log: [...(pr.log||[]), {ts: new Date().toISOString(), kind: "note", body: v}]});
    setNoteText("");
    setNoteOpen(false);
  };

  const doneCircle = (
    <button onClick={toggleDone} aria-label={isDone?"Mark open":"Mark done"}
      style={{
        width:18, height:18, borderRadius:"50%",
        border:"1.5px solid "+(isDone ? C.green : C.borderHover),
        background: isDone ? C.green : "transparent",
        color:"white", padding:0, flexShrink:0,
        display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer",
        transition:"background .12s, border-color .12s",
      }}>
      {isDone && <I.check size={11} stroke={3.5}/>}
    </button>
  );

  const dueText = pr.dueDate ? formatDue(pr.dueDate) : null;
  const dueStyle = {
    fontSize:12,
    color: isDone ? C.textMuted : isOverdue ? C.redDark : C.textSub,
    fontFamily:F, fontVariantNumeric:"tabular-nums",
    fontWeight: isOverdue && !isDone ? 600 : 500,
    whiteSpace:"nowrap", flexShrink:0,
  };

  const noteBar = noteOpen && !expanded ? (
    <div style={{padding:"8px 14px", background:C.bgSubtle, borderTop:"1px solid "+C.bg,
      display:"flex", gap:8, alignItems:"center"}}>
      <I.messageSquare size={14} style={{color:C.textMuted, flexShrink:0}}/>
      <input autoFocus value={noteText} onChange={e=>setNoteText(e.target.value)}
        onKeyDown={e=>{
          if (e.key === "Enter") submitInlineNote();
          if (e.key === "Escape") { setNoteText(""); setNoteOpen(false); }
        }}
        placeholder={mobile ? "Quick note…" : "Quick note — Enter to save, Esc to cancel"}
        style={{...iS(mobile), flex:1, minWidth:0}} />
      {mobile ? (
        <button onClick={submitInlineNote} disabled={!noteText.trim()}
          {...btnStyle("primary","sm")}>Save</button>
      ) : (
        <button onClick={()=>{ setNoteText(""); setNoteOpen(false); }}
          {...btnStyle("ghost","sm", {color:C.textMuted})}>Cancel</button>
      )}
    </div>
  ) : null;

  // ----- MOBILE LAYOUT: stacked 2-line row, no hover quick-actions -----
  if (mobile) {
    return (
      <div className="dh-row" style={{borderBottom:"1px solid "+C.bgSubtle}}>
        <div onClick={()=>{ setNoteOpen(false); setExpanded(x=>!x); }}
          style={{
            display:"flex", gap:10, padding:"10px 14px", alignItems:"flex-start",
            cursor:"pointer", background: expanded ? C.bgSubtle : "transparent",
          }}>
          <div style={{paddingTop:2, flexShrink:0}}>{doneCircle}</div>
          <div style={{flex:1, minWidth:0}}>
            {/* Line 1: name + due */}
            <div style={{display:"flex", gap:8, alignItems:"baseline", minWidth:0}}>
              <div style={{
                flex:1, minWidth:0, fontSize:14,
                color: isDone ? C.textMuted : C.text, fontFamily:F,
                textDecoration: isDone ? "line-through" : "none",
                letterSpacing:"-0.005em", lineHeight:1.35,
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
              }}>
                {isHigh && !isDone && (
                  <span title="High priority"
                    style={{display:"inline-block", width:6, height:6, borderRadius:"50%",
                      background:C.red, marginRight:6, verticalAlign:"middle"}}/>
                )}
                {pr.name || <span style={{color:C.textMuted, fontStyle:"italic"}}>Untitled</span>}
              </div>
              {dueText && <span style={dueStyle}>{dueText}</span>}
            </div>
            {/* Line 2: meta (pill + property + contractor + cost + photos) */}
            <div style={{display:"flex", gap:8, alignItems:"center", flexWrap:"wrap", marginTop:6, minWidth:0}}>
              <TypePill type={typeOf(pr)} />
              {showProperty && propLabel && (
                <span onClick={onPropertyClick ? (e=>{e.stopPropagation(); onPropertyClick();}) : undefined}
                  style={{
                    fontSize:12, color:onPropertyClick ? C.textSub : C.textMuted, fontFamily:F,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                    minWidth:0, maxWidth:"100%",
                    ...(onPropertyClick ? {cursor:"pointer"} : {}),
                  }}>{propLabel}</span>
              )}
              {pr.contractor && (
                <span style={{fontSize:12, color:C.textMuted, fontFamily:F, whiteSpace:"nowrap"}}>
                  {(showProperty && propLabel) ? "· " : ""}{pr.contractor}
                </span>
              )}
              {pr.budget > 0 && (
                <span style={{fontSize:12, color:"#3f3f46", fontFamily:F, fontWeight:500,
                  fontVariantNumeric:"tabular-nums", whiteSpace:"nowrap"}}>
                  ${Math.round(pr.budget).toLocaleString()}
                </span>
              )}
              {(pr.photos||[]).length > 0 && (
                <span style={{display:"inline-flex", alignItems:"center", gap:3,
                  color:C.textMuted, fontSize:11, fontFamily:F}}>
                  <I.camera size={11}/>{pr.photos.length}
                </span>
              )}
            </div>
          </div>
        </div>
        {/* On mobile, quick actions (snooze / note) live inside the expanded
            edit view — tapping the row anywhere expands it. Keeps the
            collapsed row visually clean. */}
        {expanded && (
          <FollowupExpanded pr={pr} onChange={onChange} onDelete={onDelete} mobile={mobile} contractors={contractors} onAddExpense={onAddExpense} isExpensed={isExpensed} />
        )}
      </div>
    );
  }

  // ----- DESKTOP LAYOUT: single horizontal row with hover quick-actions -----
  return (
    <div className="dh-row" style={{borderBottom:"1px solid "+C.bgSubtle}}>
      <div onClick={()=>{ setNoteOpen(false); setExpanded(x=>!x); }}
        style={{
          display:"flex", gap:10, padding:"10px 14px", alignItems:"center", cursor:"pointer",
          transition:"background .12s",
          background: expanded ? C.bgSubtle : "transparent",
        }}
        onMouseEnter={e=>{ if (!expanded) e.currentTarget.style.background=C.bgSubtle; }}
        onMouseLeave={e=>{ if (!expanded) e.currentTarget.style.background="transparent"; }}>
        {doneCircle}

        <TypePill type={typeOf(pr)} />

        {isHigh && !isDone && (
          <span title="High priority"
            style={{width:6, height:6, borderRadius:"50%", background:C.red, flexShrink:0}}/>
        )}

        <div style={{flex:1, minWidth:0, display:"flex", flexDirection:"column", gap:1}}>
          <div style={{fontSize:13, color: isDone ? C.textMuted : C.text, fontFamily:F,
            textDecoration: isDone ? "line-through" : "none",
            letterSpacing:"-0.005em",
            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
            {pr.name || <span style={{color:C.textMuted, fontStyle:"italic"}}>Untitled</span>}
          </div>
          {(showProperty && propLabel) || pr.contractor ? (
            <div style={{fontSize:11, color:C.textMuted, fontFamily:F, display:"flex", gap:6,
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
              {showProperty && propLabel && (
                onPropertyClick
                  ? <span onClick={e=>{e.stopPropagation(); onPropertyClick();}}
                      style={{cursor:"pointer", color:C.textSub}}>
                      {propLabel}
                    </span>
                  : <span>{propLabel}</span>
              )}
              {pr.contractor && <span style={{color:C.textMuted}}>· {pr.contractor}</span>}
            </div>
          ) : null}
        </div>

        <div style={{display:"flex", alignItems:"center", gap:10, flexShrink:0}}>
          {dueText && <span style={dueStyle}>{dueText}</span>}
          {pr.budget > 0 && (
            <span style={{fontSize:12, color:"#3f3f46", fontFamily:F, fontWeight:500, fontVariantNumeric:"tabular-nums"}}>
              ${Math.round(pr.budget).toLocaleString()}
            </span>
          )}
          {(pr.photos||[]).length > 0 && (
            <span style={{display:"inline-flex", alignItems:"center", gap:3, color:C.textMuted, fontSize:11, fontFamily:F}}>
              <I.camera size={12}/>{pr.photos.length}
            </span>
          )}
          {!isDone && (
            <div className="dh-row-actions">
              <RowAction icon={<I.check size={14} stroke={2.2}/>}    label="Mark done"        onClick={toggleDone}/>
              <RowAction icon={<I.clock size={14}/>}                  label="Snooze 1 day"     onClick={snooze}/>
              <RowAction icon={<I.messageSquare size={14}/>}          label="Add note"         onClick={openNoteBar}/>
            </div>
          )}
          <I.chevronDown size={14}
            style={{color:C.textMuted, transition:"transform .15s",
              transform: expanded ? "rotate(180deg)" : "none"}}/>
        </div>
      </div>
      {noteBar}
      {expanded && (
        <FollowupExpanded pr={pr} onChange={onChange} onDelete={onDelete} mobile={mobile} contractors={contractors} onAddExpense={onAddExpense} isExpensed={isExpensed} />
      )}
    </div>
  );
}

function QuickAddForm({onAdd, mobile, contractors=[]}) {
  const [open, setOpen]           = useState(false);
  const [text, setText]           = useState("");
  const [type, setType]           = useState("other");
  const [date, setDate]           = useState("");
  const [cost, setCost]           = useState("");
  const [contractor, setContractor] = useState("");

  const submit = () => {
    if (!text.trim()) return;
    onAdd({name:text.trim(), type, dueDate:date, budget:parseFloat(cost)||0,
      contractor:contractor.trim(), priority:"normal"});
    setText(""); setType("other"); setDate(""); setCost(""); setContractor("");
    setOpen(false);
  };
  const cancel = () => {
    setText(""); setType("other"); setDate(""); setCost(""); setContractor("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button onClick={()=>setOpen(true)}
        style={{
          width:"100%", padding:"11px 14px", border:"none",
          background:"transparent", color:C.textSub,
          fontFamily:F, fontSize:13, fontWeight:500, cursor:"pointer",
          display:"flex", alignItems:"center", justifyContent:"center", gap:6,
          borderTop:"1px solid "+C.border,
          transition:"background .12s, color .12s",
        }}
        onMouseEnter={e=>{e.currentTarget.style.background=C.bgSubtle; e.currentTarget.style.color=C.text;}}
        onMouseLeave={e=>{e.currentTarget.style.background="transparent"; e.currentTarget.style.color=C.textSub;}}>
        <I.plus size={14}/> Add follow-up
      </button>
    );
  }

  return (
    <div style={{padding:mobile?"14px 14px":"14px 16px", borderTop:"1px solid "+C.border, background:C.bgSubtle}}>
      <input value={text} onChange={e=>setText(e.target.value)}
        onKeyDown={e=>{
          if (e.key==="Enter") submit();
          if (e.key==="Escape") cancel();
        }}
        autoFocus
        placeholder="What needs to be done?"
        style={{...iS(mobile), marginBottom:10}} />
      <div style={{marginBottom:12}}>
        <div style={{fontSize:11, color:C.textSub, fontWeight:600, marginBottom:6, fontFamily:F, letterSpacing:".03em", textTransform:"uppercase"}}>Type</div>
        <TypePicker value={type} onChange={setType}/>
      </div>
      <div style={{display:"grid", gridTemplateColumns: mobile ? "1fr 1fr" : "1fr 1fr 1.5fr", gap:8, marginBottom:12}}>
        <input type="date" value={date} onChange={e=>setDate(e.target.value)} style={iS(mobile)}/>
        <input type="number" value={cost} onChange={e=>setCost(e.target.value)}
          placeholder="Cost ($)" inputMode="decimal" style={iS(mobile)}/>
        <input value={contractor} onChange={e=>setContractor(e.target.value)}
          list="dh-contractors" placeholder="Contractor"
          style={{...iS(mobile), gridColumn: mobile ? "span 2" : "auto"}}/>
      </div>
      {contractors.length > 0 && (
        <datalist id="dh-contractors">
          {contractors.map(c => <option key={c} value={c}/>)}
        </datalist>
      )}
      <div style={{display:"flex", gap:8, justifyContent:"flex-end"}}>
        <button onClick={cancel} {...btnStyle("ghost","sm")}>Cancel</button>
        <button onClick={submit} disabled={!text.trim()} {...btnStyle("primary","sm")}>
          <I.plus size={12}/> Add follow-up
        </button>
      </div>
    </div>
  );
}

const followupSort = (a, b) => {
  const aD = a.status === "Complete" ? 1 : 0;
  const bD = b.status === "Complete" ? 1 : 0;
  if (aD !== bD) return aD - bD;
  const aH = a.priority === "high" ? 0 : 1;
  const bH = b.priority === "high" ? 0 : 1;
  if (aH !== bH) return aH - bH;
  if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
  if (a.dueDate) return -1;
  if (b.dueDate) return 1;
  return 0;
};

// Worst open-status for a property's left-border + summary dot.
const propertyStatus = (property) => {
  const today = startOfToday();
  const inWeek = new Date(today.getTime() + 7*86400000);
  const open = (property.projects||[]).filter(pr => pr.status !== "Complete");
  const overdueItems = open.filter(pr => pr.dueDate && new Date(pr.dueDate+"T00:00:00") < today);
  const dueSoonItems = open.filter(pr => pr.dueDate && new Date(pr.dueDate+"T00:00:00") <= inWeek && new Date(pr.dueDate+"T00:00:00") >= today);
  if (overdueItems.length) return {kind:"overdue", color:C.red, openCount:open.length, overdueCount:overdueItems.length};
  if (dueSoonItems.length) return {kind:"due-soon", color:C.amber, openCount:open.length, overdueCount:0};
  if (open.length === 0) return {kind:"clear", color:C.green, openCount:0, overdueCount:0};
  return {kind:"open", color:C.borderHover, openCount:open.length, overdueCount:0};
};

function PropertySection({property, onUpdateProjects, mobile, filterMode, search, contractor, contractors=[], hideHeader=false, onAddExpense}) {
  const expensedIds = new Set((property.expenses||[]).map(e => e.fromFollowup).filter(Boolean));
  const projects = property.projects || [];
  const filtered = projects.filter(pr => {
    if (filterMode === "open" && pr.status === "Complete") return false;
    if (filterMode === "done" && pr.status !== "Complete") return false;
    if (contractor && (pr.contractor||"") !== contractor) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${pr.name||""} ${pr.contractor||""} ${pr.details||""} ${(pr.log||[]).filter(l=>l.kind!=="event").map(l=>l.body||l.note||"").join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const sorted = [...filtered].sort(followupSort);

  const updateOne = (updated) => onUpdateProjects(projects.map(pr => pr.id === updated.id ? updated : pr));
  const deleteOne = (id) => onUpdateProjects(projects.filter(pr => pr.id !== id));
  const addOne = (item) => onUpdateProjects([...projects, {
    id:"pr"+Date.now(),
    status:"In Progress",
    name:"", dueDate:"", budget:0, spent:0,
    contractor:"", details:"", priority:"normal", photos:[], log:[],
    type:"other",
    isCapEx: !property.occupied,
    ...item,
  }]);

  const status = propertyStatus(property);

  // Status pill content + tone.
  const pill = status.kind === "overdue"
    ? {bg: C.redSubtle,    border: C.redBorder,    color: C.redDark,    dot: C.red,    label: `${status.overdueCount} overdue`}
    : status.kind === "due-soon"
      ? {bg: C.amberSubtle,  border: C.amberBorder,  color: C.amberDark,  dot: C.amber,  label: `${status.openCount} open`}
      : status.kind === "clear"
        ? {bg: C.greenSubtle,  border: C.greenBorder,  color: C.greenDark,  dot: C.green,  label: "All clear"}
        : {bg: C.bgSubtle,     border: C.border,       color: C.textSub,    dot: C.borderHover, label: `${status.openCount} open`};

  return (
    <Card id={"prop-"+property.id} className="dh-prop-card"
      style={{marginBottom:14}} padding={0}>
      {!hideHeader && (
        <header style={{padding:mobile?"14px 16px":"16px 18px", display:"flex", justifyContent:"space-between", alignItems:"center", gap:10, borderBottom:projects.length||filterMode!=="open"?"1px solid "+C.border:"none"}}>
          <div style={{minWidth:0, flex:1}}>
            <h3 style={{margin:0, fontSize:mobile?15:16, fontWeight:600, color:C.text, fontFamily:F, letterSpacing:"-0.015em",
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{property.address}</h3>
            <div style={{fontSize:12, color:C.textMuted, fontFamily:F, marginTop:2,
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
              {property.city}{property.state?`, ${property.state}`:""}
            </div>
          </div>
          <span style={{
            display:"inline-flex", alignItems:"center", gap:6, flexShrink:0,
            padding:"4px 9px", borderRadius:9999, fontFamily:F,
            background:pill.bg, border:"1px solid "+pill.border, color:pill.color,
            fontSize:11, fontWeight:600, letterSpacing:"-0.005em",
          }}>
            <span className={status.kind === "overdue" ? "dh-pulse" : undefined}
              style={{width:6, height:6, borderRadius:"50%", background:pill.dot, flexShrink:0}}/>
            <span style={{fontVariantNumeric:"tabular-nums"}}>{pill.label}</span>
          </span>
        </header>
      )}
      {sorted.length === 0 ? (
        <div style={{padding:"32px 16px 26px", textAlign:"center", display:"flex", flexDirection:"column", alignItems:"center", gap:8}}>
          {!search && filterMode === "open" ? (
            <>
              <div style={{
                width:36, height:36, borderRadius:"50%", background:C.greenSubtle,
                border:"1px solid "+C.greenBorder, color:C.greenDark,
                display:"flex", alignItems:"center", justifyContent:"center",
              }}>
                <I.check size={17} stroke={2.5}/>
              </div>
              <div style={{fontSize:13, color:C.textSub, fontFamily:F, fontWeight:500}}>All caught up</div>
              <div style={{fontSize:12, color:C.textMuted, fontFamily:F}}>No open follow-ups on this property</div>
            </>
          ) : (
            <div style={{fontSize:13, color:C.textMuted, fontFamily:F}}>
              {filterMode === "done" ? "No completed follow-ups yet." : "Nothing matches your filters."}
            </div>
          )}
        </div>
      ) : (
        sorted.map(pr => (
          <FollowupRow key={pr.id} pr={pr} contractors={contractors}
            onChange={updateOne} onDelete={()=>deleteOne(pr.id)} mobile={mobile}
            onAddExpense={onAddExpense} isExpensed={expensedIds.has(pr.id)} />
        ))
      )}
      <QuickAddForm onAdd={addOne} mobile={mobile} contractors={contractors} />
    </Card>
  );
}

function ContractorChip({label, active, onClick}) {
  return (
    <button onClick={onClick} style={{
      flexShrink:0, padding:"6px 12px", borderRadius:9999,
      background: active ? C.text : C.card,
      color: active ? "#fff" : C.textSub,
      border: "1px solid " + (active ? C.text : C.border),
      fontSize:12, fontWeight:600, fontFamily:F, cursor:"pointer",
      letterSpacing:"-0.005em", whiteSpace:"nowrap",
      transition: "background .12s, color .12s, border-color .12s",
    }}>{label}</button>
  );
}

// Group an array of {pr, property} rows by property, preserving the order
// each property first appeared in. Returns [{property, prs:[pr,…]}, …].
const groupByProperty = (rows) => {
  const groups = [];
  const seen = new Map();
  for (const {pr, property} of rows) {
    if (!seen.has(property.id)) {
      const g = {property, prs: []};
      seen.set(property.id, g);
      groups.push(g);
    }
    seen.get(property.id).prs.push(pr);
  }
  return groups;
};

// Property "subheader" used to label a group of follow-ups in a Due-Now bucket
// or the day-view. Clickable: navigates to the matching property card below.
function PropertyGroupHeader({property, onClick, mobile, isFirst}) {
  return (
    <button onClick={onClick}
      className="dh-prop-subheader"
      style={{
        width:"100%", padding: mobile ? "10px 14px 8px" : "11px 18px 8px",
        background:"transparent", border:"none",
        borderTop: isFirst ? "none" : "1px solid "+C.border,
        display:"flex", alignItems:"center", justifyContent:"space-between",
        cursor:"pointer", textAlign:"left", gap:8,
        transition:"background .12s",
      }}>
      <div style={{display:"flex", alignItems:"baseline", gap:8, minWidth:0, flex:1}}>
        <span style={{
          fontSize: mobile ? 13 : 14, fontWeight:600, color:C.text, fontFamily:F,
          letterSpacing:"-0.005em",
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
        }}>
          {property.address}
        </span>
        {property.city && (
          <span style={{
            fontSize:12, color:C.textMuted, fontFamily:F, flexShrink:0,
            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
          }}>
            {property.city}{property.state ? `, ${property.state}` : ""}
          </span>
        )}
      </div>
      <I.chevronRight size={14} style={{color:C.textMuted, flexShrink:0}}/>
    </button>
  );
}

function DueNowSection({title, items, tone, onPropertyClick, onRowChange, onRowDelete, onAddExpense, mobile, contractors}) {
  if (!items.length) return null;
  const groups = groupByProperty(items);
  return (
    <div>
      <header style={{
        padding: mobile ? "11px 14px" : "12px 18px",
        display: "flex", alignItems: "center", gap: 10,
        background: tone.bg,
        borderBottom: "1px solid " + tone.border,
      }}>
        <span style={{width:9, height:9, borderRadius:"50%", background:tone.dot, flexShrink:0}}/>
        <span style={{
          fontSize: mobile ? 12 : 13, fontWeight:700, color:tone.text, fontFamily:F,
          letterSpacing:".08em", textTransform:"uppercase",
        }}>
          {title}
        </span>
        <span style={{
          fontSize:11, color:"#fff", fontFamily:F, fontWeight:700,
          fontVariantNumeric:"tabular-nums",
          background:tone.dot, padding:"2px 8px",
          borderRadius:9999, minWidth:22, textAlign:"center", lineHeight:1.4,
        }}>
          {items.length}
        </span>
      </header>
      <div>
        {groups.map(({property, prs}, idx) => (
          <React.Fragment key={property.id}>
            <PropertyGroupHeader property={property} mobile={mobile} isFirst={idx === 0}
              onClick={() => onPropertyClick(property.id)} />
            {prs.map(pr => (
              <FollowupRow key={pr.id} pr={pr} showProperty={false}
                onChange={updated => onRowChange(property, updated)}
                onDelete={() => onRowDelete(property, pr.id)}
                onAddExpense={exp => onAddExpense(property, exp)}
                isExpensed={(property.expenses||[]).some(e => e.fromFollowup === pr.id)}
                mobile={mobile} contractors={contractors} />
            ))}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// Compact month calendar with a dot on every day that has follow-ups due.
// Tap a day → focused day view in ProjectsPage; tap again to clear. Past days
// with items get a red dot (overdue), today/future days get an orange one.
function ProjectsCalendar({allOpen, mobile, selectedDate, onSelectDate}) {
  const todayKey = todayIso();
  const [viewMonth, setViewMonth] = useState(() => {
    const seed = selectedDate ? new Date(selectedDate + "T00:00:00") : new Date();
    return new Date(seed.getFullYear(), seed.getMonth(), 1);
  });

  // Re-anchor the visible month if the parent selects a date in a different month.
  useEffect(() => {
    if (!selectedDate) return;
    const d = new Date(selectedDate + "T00:00:00");
    if (d.getFullYear() !== viewMonth.getFullYear() || d.getMonth() !== viewMonth.getMonth()) {
      setViewMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  const year  = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startWeekday = new Date(year, month, 1).getDay();

  // Count items due per day (within the visible month only).
  const itemsByDay = {};
  allOpen.forEach(({pr}) => {
    if (!pr.dueDate) return;
    const d = new Date(pr.dueDate + "T00:00:00");
    if (d.getFullYear() === year && d.getMonth() === month) {
      itemsByDay[pr.dueDate] = (itemsByDay[pr.dueDate] || 0) + 1;
    }
  });

  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    cells.push({day:d, dateStr, count: itemsByDay[dateStr] || 0});
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const monthLabel = viewMonth.toLocaleString("en-US", {month:"long", year:"numeric"});
  const goToToday  = () => {
    const t = new Date();
    setViewMonth(new Date(t.getFullYear(), t.getMonth(), 1));
    onSelectDate(todayKey);
  };
  const prevMonth  = () => setViewMonth(new Date(year, month - 1, 1));
  const nextMonth  = () => setViewMonth(new Date(year, month + 1, 1));

  const navBtn = (icon, onClick, label) => (
    <button onClick={onClick} aria-label={label}
      className="dh-cal-nav"
      style={{
        width:30, height:30, borderRadius:C.r1, border:"none", background:"transparent",
        color:C.textSub, cursor:"pointer",
        display:"inline-flex", alignItems:"center", justifyContent:"center",
        transition:"background .12s, color .12s",
      }}>{icon}</button>
  );

  const totalDueThisMonth = Object.values(itemsByDay).reduce((s,n) => s+n, 0);

  return (
    <Card style={{marginBottom:20, padding: mobile ? "14px 14px 12px" : "16px 18px 14px"}}>
      <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12, gap:8}}>
        <div style={{display:"flex", alignItems:"center", gap:2}}>
          {navBtn(<I.chevronLeft size={16}/>, prevMonth, "Previous month")}
          <span style={{fontSize:14, fontWeight:600, color:C.text, fontFamily:F,
            padding:"0 8px", letterSpacing:"-0.01em", minWidth: mobile?130:150, textAlign:"center"}}>
            {monthLabel}
          </span>
          {navBtn(<I.chevronRight size={16}/>, nextMonth, "Next month")}
        </div>
        <div style={{display:"flex", alignItems:"center", gap:8}}>
          {totalDueThisMonth > 0 && (
            <span style={{fontSize:11, color:C.textMuted, fontFamily:F, fontVariantNumeric:"tabular-nums", fontWeight:500}}>
              {totalDueThisMonth} due
            </span>
          )}
          <button onClick={goToToday}
            style={{
              background:"transparent", border:"1px solid "+C.border, borderRadius:C.r1,
              padding:"4px 10px", fontSize:12, fontWeight:600, color:C.textSub,
              cursor:"pointer", fontFamily:F, letterSpacing:"-0.005em",
              transition:"background .12s, color .12s, border-color .12s",
            }}
            onMouseEnter={e=>{e.currentTarget.style.background=C.bgSubtle; e.currentTarget.style.color=C.text;}}
            onMouseLeave={e=>{e.currentTarget.style.background="transparent"; e.currentTarget.style.color=C.textSub;}}>
            Today
          </button>
        </div>
      </div>

      <div style={{display:"grid", gridTemplateColumns:"repeat(7, 1fr)", gap:2, marginBottom:4}}>
        {["S","M","T","W","T","F","S"].map((d, i) => (
          <div key={i} style={{
            textAlign:"center", fontSize:10, fontWeight:700, color:C.textMuted,
            fontFamily:F, letterSpacing:".06em", textTransform:"uppercase", padding:"4px 0",
          }}>{d}</div>
        ))}
      </div>

      <div style={{display:"grid", gridTemplateColumns:"repeat(7, 1fr)", gap:2}}>
        {cells.map((cell, i) => {
          if (!cell) return <div key={`pad-${i}`} style={{aspectRatio:"1 / 1"}}/>;
          const isToday    = cell.dateStr === todayKey;
          const isSelected = cell.dateStr === selectedDate;
          const isPast     = cell.dateStr < todayKey;
          const hasItems   = cell.count > 0;
          const dotColor   = isSelected ? "#fff" : isPast ? C.red : C.green;
          return (
            <button key={cell.dateStr}
              onClick={() => onSelectDate(isSelected ? null : cell.dateStr)}
              aria-label={`${cell.dateStr}${hasItems ? `, ${cell.count} item${cell.count===1?"":"s"} due` : ""}`}
              aria-pressed={isSelected}
              className="dh-cal-day"
              style={{
                aspectRatio:"1 / 1", padding:0, border:"none", cursor:"pointer",
                borderRadius:C.r2,
                background: isSelected ? C.green
                          : isToday    ? C.greenSubtle
                          : "transparent",
                color:      isSelected ? "#fff"
                          : isToday    ? C.greenDark
                          : C.text,
                position:"relative",
                display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:1,
                transition:"background .12s, color .12s",
                fontFamily:F, fontSize: mobile ? 13 : 14,
                fontWeight: isToday || isSelected ? 700 : 500,
                fontVariantNumeric:"tabular-nums",
                outline: isToday && !isSelected ? `1px solid ${C.greenBorder}` : "none",
                outlineOffset: -1,
              }}>
              <span style={{lineHeight:1}}>{cell.day}</span>
              {hasItems && (
                <span style={{
                  width: cell.count > 1 ? 14 : 5,
                  height: 5, marginTop: 2,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  gap:2,
                }}>
                  <span style={{width:5, height:5, borderRadius:"50%", background:dotColor}}/>
                  {cell.count > 1 && (
                    <span style={{
                      fontSize:9, fontWeight:700, color: isSelected ? "rgba(255,255,255,.85)" : C.textMuted,
                      lineHeight:1, fontVariantNumeric:"tabular-nums",
                    }}>{cell.count}</span>
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function ProjectsPage({properties, onUpdateProperty, mobile}) {
  const isWide = useIsWide();
  const [filterMode, setFilterMode] = useState("open");
  const [search, setSearch]         = useState("");
  // When set (YYYY-MM-DD), the page enters a focused "day view" showing only
  // items due that day, and the calendar highlights the selection.
  const [selectedDate, setSelectedDate] = useState(null);

  // Start at the top of the page every time Projects opens — without this,
  // the window keeps its scroll position from whatever page was just shown.
  useEffect(() => { window.scrollTo(0, 0); }, []);
  // Persist contractor selection in URL ?contractor=...
  const [contractor, setContractor] = useState(() => {
    try { return new URLSearchParams(window.location.search).get("contractor") || ""; } catch { return ""; }
  });
  useEffect(() => {
    try {
      const url = new URL(window.location);
      if (contractor) url.searchParams.set("contractor", contractor);
      else url.searchParams.delete("contractor");
      window.history.replaceState({}, "", url.toString());
    } catch {}
  }, [contractor]);

  // Build unique sorted contractor list across all properties.
  const contractors = Array.from(new Set(
    properties.flatMap(p => (p.projects||[])
      .map(pr => (pr.contractor||"").trim())
      .filter(Boolean))
  )).sort((a,b) => a.localeCompare(b));

  const today    = startOfToday();
  const tomorrow = new Date(today.getTime() + 86400000);
  const inWeek   = new Date(today.getTime() + 7*86400000);

  // All open follow-ups with their owning property, after contractor filter.
  const allOpen = properties.flatMap(p =>
    (p.projects||[])
      .filter(pr => pr.status !== "Complete")
      .filter(pr => !contractor || (pr.contractor||"") === contractor)
      .map(pr => ({pr, property:p}))
  );

  const sortByDue = (a, b) => (a.pr.dueDate||"").localeCompare(b.pr.dueDate||"");
  const overdue  = allOpen.filter(({pr}) => pr.dueDate && new Date(pr.dueDate+"T00:00:00") < today).sort(sortByDue);
  const todayItems = allOpen.filter(({pr}) => pr.dueDate && new Date(pr.dueDate+"T00:00:00") >= today && new Date(pr.dueDate+"T00:00:00") < tomorrow).sort(sortByDue);
  const thisWeek = allOpen.filter(({pr}) => pr.dueDate && new Date(pr.dueDate+"T00:00:00") >= tomorrow && new Date(pr.dueDate+"T00:00:00") <= inWeek).sort(sortByDue);
  const dueNowTotal = overdue.length + todayItems.length + thisWeek.length;

  const openTotal = allOpen.length;

  const pageBg = "#FAFAF7";

  const handleUpdateProjects = (propId, projects) => {
    const property = properties.find(p => p.id === propId);
    if (property) onUpdateProperty({...property, projects});
  };
  const handleRowChange = (property, updated) =>
    handleUpdateProjects(property.id, (property.projects||[]).map(x => x.id === updated.id ? updated : x));
  const handleRowDelete = (property, id) =>
    handleUpdateProjects(property.id, (property.projects||[]).filter(x => x.id !== id));
  const handleAddExpense = (property, exp) =>
    onUpdateProperty({...property, expenses: [...(property.expenses||[]), exp]});
  const scrollToProperty = (id) => {
    const el = document.getElementById("prop-" + id);
    if (el) el.scrollIntoView({behavior:"smooth", block:"start"});
  };

  if (properties.length === 0) {
    return (
      <div style={{
        background:pageBg, minHeight:"100%",
        paddingTop:    mobile ? 20 : 32,
        paddingBottom: mobile ? 100 : 32,
        paddingLeft:   `calc(${mobile?24:32}px + env(safe-area-inset-left, 0px))`,
        paddingRight:  `calc(${mobile?24:32}px + env(safe-area-inset-right, 0px))`,
      }}>
        <PageHeader title="Projects" subtitle="Track follow-ups across your portfolio"/>
        <EmptyState
          icon={<I.clipboardCheck size={22}/>}
          title="Add a property first"
          body="Once you have properties in your portfolio, this is where you'll capture every follow-up from contractor calls — what's due, what it costs, and whether it's done."
        />
      </div>
    );
  }

  const overdueCount = overdue.length;

  // Day view: every follow-up due on the selected date, open or done, across
  // properties (with the contractor filter still applied). Open items first.
  const selectedDayItems = selectedDate
    ? properties.flatMap(p =>
        (p.projects || [])
          .filter(pr => pr.dueDate === selectedDate)
          .filter(pr => !contractor || (pr.contractor || "") === contractor)
          .map(pr => ({pr, property: p}))
      ).sort((a, b) => {
        const aDone = a.pr.status === "Complete" ? 1 : 0;
        const bDone = b.pr.status === "Complete" ? 1 : 0;
        return aDone - bDone;
      })
    : [];

  const selectedDayLabel = selectedDate
    ? (() => {
        const d = new Date(selectedDate + "T00:00:00");
        const today = startOfToday();
        const that  = new Date(d); that.setHours(0,0,0,0);
        const diff  = Math.round((that - today) / 86400000);
        const md    = d.toLocaleDateString("en-US", {month:"long", day:"numeric"});
        if (diff === 0)  return `Today · ${md}`;
        if (diff === -1) return `Yesterday · ${md}`;
        if (diff === 1)  return `Tomorrow · ${md}`;
        const wd = d.toLocaleDateString("en-US", {weekday:"long"});
        const sameYear = d.getFullYear() === new Date().getFullYear();
        return sameYear ? `${wd} · ${md}` : `${wd} · ${md}, ${d.getFullYear()}`;
      })()
    : "";

  return (
    <div style={{
      background:pageBg, minHeight:"100%",
      paddingTop:    mobile ? 20 : 32,
      paddingBottom: mobile ? 100 : 32,
      paddingLeft:   `calc(${mobile?24:32}px + env(safe-area-inset-left, 0px))`,
      paddingRight:  `calc(${mobile?24:32}px + env(safe-area-inset-right, 0px))`,
    }}>
      {/* Header with inline stats */}
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start",
        gap:16, flexWrap:"wrap", marginBottom:20}}>
        <div style={{minWidth:0}}>
          <h1 style={{margin:0, fontSize:24, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.02em"}}>
            Projects
          </h1>
          <p style={{margin:"4px 0 0", fontSize:14, color:C.textSub, fontFamily:F}}>
            {openTotal === 0
              ? "All clear across the portfolio."
              : `Track every follow-up across ${properties.length} ${properties.length===1?"property":"properties"}.`}
          </p>
        </div>
        {openTotal > 0 && (
          <div style={{display:"flex", gap:0, alignItems:"stretch",
            background:C.card, border:"1px solid "+C.border, borderRadius:C.r3, padding:2,
            boxShadow:C.sh1}}>
            <div style={{padding:"6px 12px", display:"flex", alignItems:"center", gap:6, fontFamily:F}}>
              <span style={{fontSize:11, color:C.textMuted, fontWeight:600,
                letterSpacing:".04em", textTransform:"uppercase"}}>Open</span>
              <span style={{fontSize:14, fontWeight:700, color:C.text, fontVariantNumeric:"tabular-nums"}}>{openTotal}</span>
            </div>
            {overdueCount > 0 && (
              <>
                <span style={{width:1, background:C.border, margin:"4px 0"}}/>
                <div style={{padding:"6px 12px", display:"flex", alignItems:"center", gap:6, fontFamily:F}}>
                  <span style={{width:6, height:6, borderRadius:"50%", background:C.red, flexShrink:0}}/>
                  <span style={{fontSize:11, color:C.redDark, fontWeight:600,
                    letterSpacing:".04em", textTransform:"uppercase"}}>Overdue</span>
                  <span style={{fontSize:14, fontWeight:700, color:C.redDark, fontVariantNumeric:"tabular-nums"}}>{overdueCount}</span>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Calendar — always visible at the top */}
      <ProjectsCalendar allOpen={allOpen} mobile={mobile}
        selectedDate={selectedDate} onSelectDate={setSelectedDate} />

      {selectedDate ? (
        /* Focused day view: just the items due on this day */
        <Card padding={0}>
          <header style={{
            padding: mobile ? "14px 16px" : "16px 18px",
            display:"flex", alignItems:"center", justifyContent:"space-between", gap:10,
            borderBottom: selectedDayItems.length ? "1px solid "+C.border : "none",
          }}>
            <div style={{minWidth:0}}>
              <div style={{fontSize:11, fontWeight:700, color:C.textSub, fontFamily:F,
                letterSpacing:".06em", textTransform:"uppercase"}}>Due</div>
              <div style={{fontSize: mobile ? 15 : 16, fontWeight:600, color:C.text, fontFamily:F,
                letterSpacing:"-0.01em", marginTop:2}}>
                {selectedDayLabel}
              </div>
              <div style={{fontSize:12, color:C.textMuted, fontFamily:F, marginTop:2,
                fontVariantNumeric:"tabular-nums"}}>
                {selectedDayItems.length === 0
                  ? "Nothing scheduled"
                  : `${selectedDayItems.length} item${selectedDayItems.length===1?"":"s"}`}
              </div>
            </div>
            <button onClick={() => setSelectedDate(null)} {...btnStyle("secondary","sm")}>
              <I.x size={12} stroke={2.5}/> Clear
            </button>
          </header>
          {selectedDayItems.length === 0 ? (
            <div style={{padding:"32px 16px", textAlign:"center"}}>
              <div style={{fontSize:13, color:C.textMuted, fontFamily:F}}>
                No follow-ups are scheduled for this day.
              </div>
            </div>
          ) : (
            groupByProperty(selectedDayItems).map(({property, prs}, idx) => (
              <React.Fragment key={property.id}>
                <PropertyGroupHeader property={property} mobile={mobile} isFirst={idx === 0}
                  onClick={() => { setSelectedDate(null); setTimeout(() => scrollToProperty(property.id), 0); }} />
                {prs.map(pr => (
                  <FollowupRow key={pr.id} pr={pr} showProperty={false}
                    onChange={updated => handleRowChange(property, updated)}
                    onDelete={() => handleRowDelete(property, pr.id)}
                    onAddExpense={exp => handleAddExpense(property, exp)}
                    isExpensed={(property.expenses||[]).some(e => e.fromFollowup === pr.id)}
                    mobile={mobile} contractors={contractors} />
                ))}
              </React.Fragment>
            ))
          )}
        </Card>
      ) : (
        /* Normal view: Due Now + filter + property sections */
        <>
          {dueNowTotal > 0 && (
            <Card style={{marginBottom:20}} padding={0}>
              <DueNowSection title="Overdue"   items={overdue}
                tone={{dot:C.red,     text:C.redDark,   bg:C.redSubtle,    border:C.redBorder}}
                onPropertyClick={scrollToProperty} onRowChange={handleRowChange} onRowDelete={handleRowDelete} onAddExpense={handleAddExpense} mobile={mobile} contractors={contractors}/>
              {overdue.length > 0 && (todayItems.length > 0 || thisWeek.length > 0) && <div style={{height:1, background:C.border}}/>}
              <DueNowSection title="Today"     items={todayItems}
                tone={{dot:C.amber,   text:C.amberDark, bg:C.amberSubtle,  border:C.amberBorder}}
                onPropertyClick={scrollToProperty} onRowChange={handleRowChange} onRowDelete={handleRowDelete} onAddExpense={handleAddExpense} mobile={mobile} contractors={contractors}/>
              {todayItems.length > 0 && thisWeek.length > 0 && <div style={{height:1, background:C.border}}/>}
              <DueNowSection title="This week" items={thisWeek}
                tone={{dot:C.textSub, text:C.text,      bg:C.bgSubtle,     border:C.border}}
                onPropertyClick={scrollToProperty} onRowChange={handleRowChange} onRowDelete={handleRowDelete} onAddExpense={handleAddExpense} mobile={mobile} contractors={contractors}/>
            </Card>
          )}

          {/* Filter + search row */}
          <div style={{display:"flex", gap:10, marginBottom:contractors.length?12:18, flexWrap:"wrap", alignItems:"center"}}>
            <div style={{display:"flex", padding:3, background:C.bgSubtle,
              border:"1px solid "+C.border, borderRadius:C.r2}}>
              {[["open","Open"],["done","Done"],["all","All"]].map(([id,label]) => {
                const active = filterMode === id;
                return (
                  <button key={id} onClick={()=>setFilterMode(id)}
                    style={{
                      padding:"5px 12px", borderRadius:C.r1, border:"none", cursor:"pointer",
                      background: active ? C.card : "transparent",
                      color: active ? C.text : C.textSub,
                      fontWeight: active?600:500, fontSize:12, fontFamily:F,
                      letterSpacing:"-0.005em",
                      boxShadow: active ? C.sh1 : "none",
                      transition:"background .12s, color .12s, box-shadow .12s",
                    }}>{label}</button>
                );
              })}
            </div>
            <div style={{position:"relative", flex:1, minWidth:220}}>
              <span style={{position:"absolute", left:12, top:"50%", transform:"translateY(-50%)",
                color:C.textMuted, pointerEvents:"none", display:"inline-flex"}}>
                <I.search size={15}/>
              </span>
              <input value={search} onChange={e=>setSearch(e.target.value)}
                placeholder={mobile ? "Search follow-ups…" : "Search follow-ups, contractors, details"}
                style={{...iS(mobile), paddingLeft:36}} />
            </div>
          </div>

          {/* Contractor chip row */}
          {contractors.length > 0 && (
            <div className="dh-chip-row" style={{display:"flex", gap:6, marginBottom:20, overflowX:"auto",
              WebkitOverflowScrolling:"touch", paddingBottom:2}}>
              <ContractorChip label="All contractors" active={!contractor} onClick={()=>setContractor("")}/>
              {contractors.map(c => (
                <ContractorChip key={c} label={c} active={contractor===c}
                  onClick={()=>setContractor(contractor===c ? "" : c)}/>
              ))}
            </div>
          )}

          <div style={{display:"grid", gridTemplateColumns: isWide ? "1fr 1fr" : "1fr", gap:14}}>
            {properties.map(p => (
              <PropertySection key={p.id} property={p}
                onUpdateProjects={projects => handleUpdateProjects(p.id, projects)}
                onAddExpense={exp => handleAddExpense(p, exp)}
                mobile={mobile} filterMode={filterMode} search={search}
                contractor={contractor} contractors={contractors} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Single-property view (inside Property Detail → Projects tab). Same components,
// just no cross-property panels.
function PropertyProjectsTab({p, set, mobile}) {
  const [filterMode, setFilterMode] = useState("open");
  const [search, setSearch]         = useState("");

  const onUpdateProjects = (projects) => set({...p, projects});
  const onAddExpense = (exp) => set({...p, expenses: [...(p.expenses||[]), exp]});

  // Just this property's contractors for the datalist.
  const contractors = Array.from(new Set(
    (p.projects||[]).map(pr => (pr.contractor||"").trim()).filter(Boolean)
  )).sort();

  const openCount = (p.projects||[]).filter(pr => pr.status !== "Complete").length;
  const doneCount = (p.projects||[]).filter(pr => pr.status === "Complete").length;

  return (
    <div>
      <div style={{display:"flex", gap:10, marginBottom:14, flexWrap:"wrap", alignItems:"center"}}>
        {/* Segmented filter control — matches the cross-property page */}
        <div style={{display:"flex", padding:3, background:C.bgSubtle,
          border:"1px solid "+C.border, borderRadius:C.r2}}>
          {[["open","Open",openCount],["done","Done",doneCount],["all","All",null]].map(([id,label,count]) => {
            const active = filterMode === id;
            return (
              <button key={id} onClick={()=>setFilterMode(id)}
                style={{
                  padding:"5px 12px", borderRadius:C.r1, border:"none", cursor:"pointer",
                  background: active ? C.card : "transparent",
                  color: active ? C.text : C.textSub,
                  fontWeight: active?600:500, fontSize:12, fontFamily:F,
                  letterSpacing:"-0.005em",
                  boxShadow: active ? C.sh1 : "none",
                  transition:"background .12s, color .12s, box-shadow .12s",
                  fontVariantNumeric:"tabular-nums",
                }}>{label}{count!=null && count>0 ? ` · ${count}` : ""}</button>
            );
          })}
        </div>
        <div style={{position:"relative", flex:1, minWidth:200}}>
          <span style={{position:"absolute", left:12, top:"50%", transform:"translateY(-50%)",
            color:C.textMuted, pointerEvents:"none", display:"inline-flex"}}>
            <I.search size={15}/>
          </span>
          <input value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="Search follow-ups"
            style={{...iS(mobile), paddingLeft:36}} />
        </div>
      </div>
      <PropertySection property={p} onUpdateProjects={onUpdateProjects} onAddExpense={onAddExpense}
        mobile={mobile} filterMode={filterMode} search={search}
        contractors={contractors} hideHeader />
    </div>
  );
}

// -- Expenses tab (per property) -----------------------------------------------
function ExpensesTab({p, set, mobile}) {
  const expenses = p.expenses || [];
  const total = expenses.reduce((s,e)=>s+(Number(e.amount)||0), 0);
  const sorted = [...expenses].sort((a,b)=>(b.date||"").localeCompare(a.date||""));

  const blank = () => ({description:"", amount:"", date:todayIso(), category:"other", contractor:""});
  const [adding, setAdding] = useState(false);
  const [form, setForm]     = useState(blank);
  const [editId, setEditId] = useState(null);
  const [editForm, setEditForm] = useState(blank);
  const uf = (f,v) => setForm(x=>({...x,[f]:v}));
  const ue = (f,v) => setEditForm(x=>({...x,[f]:v}));

  const commitAdd = () => {
    if (!form.description.trim()) return;
    set({...p, expenses:[...expenses, {
      id:"ex"+Date.now(), description:form.description.trim(),
      amount:parseFloat(form.amount)||0, date:form.date||todayIso(),
      category:form.category, contractor:form.contractor.trim(),
      createdAt:new Date().toISOString(),
    }]});
    setForm(blank()); setAdding(false);
  };
  const startEdit = (e) => { setEditId(e.id); setEditForm({
    description:e.description||"", amount:String(e.amount||""), date:e.date||todayIso(),
    category:e.category||"other", contractor:e.contractor||"",
  }); };
  const commitEdit = () => {
    set({...p, expenses:expenses.map(e=>e.id===editId?{
      ...e, description:editForm.description.trim(), amount:parseFloat(editForm.amount)||0,
      date:editForm.date, category:editForm.category, contractor:editForm.contractor.trim(),
    }:e)});
    setEditId(null);
  };
  const del = (id) => { set({...p, expenses:expenses.filter(e=>e.id!==id)}); setEditId(null); };

  // Plain render-fn (not a component) so inputs don't remount/lose focus on keystroke.
  const renderExpenseForm = (vals, setV, onSave, onCancel, saveLabel) => (
    <div>
      <InputField label="Description" type="text" val={vals.description} set={v=>setV("description",v)} mobile={mobile} />
      <div style={{display:"grid", gridTemplateColumns:mobile?"1fr 1fr":"1fr 1fr 1fr", gap:10}}>
        <InputField label="Amount" val={vals.amount} set={v=>setV("amount",v)} pre="$" mobile={mobile} />
        <DateField label="Date" value={vals.date} onChange={v=>setV("date",v)} mobile={mobile} />
        <InputField label="Contractor" type="text" val={vals.contractor} set={v=>setV("contractor",v)} mobile={mobile} />
      </div>
      <div style={{marginBottom:12}}>
        <label style={{fontSize:13, color:C.text, fontWeight:500, display:"block", marginBottom:6, fontFamily:F}}>Category</label>
        <TypePicker value={vals.category} onChange={v=>setV("category",v)} />
      </div>
      <div style={{display:"flex", gap:8, justifyContent:"flex-end"}}>
        <button onClick={onCancel} {...btnStyle("ghost","sm")}>Cancel</button>
        <button onClick={onSave} disabled={!vals.description.trim()} {...btnStyle("primary","sm")}>{saveLabel}</button>
      </div>
    </div>
  );

  return (
    <div>
      {/* Total */}
      <Card style={{padding:18, marginBottom:14}}>
        <div style={{fontSize:12, color:C.textSub, fontWeight:500, fontFamily:F}}>Total expenses</div>
        <div style={{fontSize:28, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.025em",
          fontVariantNumeric:"tabular-nums", marginTop:4}}>{$(total)}</div>
        <div style={{fontSize:12, color:C.textMuted, fontFamily:F, marginTop:4}}>
          {expenses.length} {expenses.length===1?"item":"items"} logged
        </div>
      </Card>

      {/* List */}
      {sorted.length === 0 ? (
        <EmptyState icon={<I.chart size={20}/>} title="No expenses yet"
          body="Log expenses here, or hit “Add as expense” on any follow-up in the Projects tab." />
      ) : (
        <Card padding={0} style={{marginBottom:14}}>
          {sorted.map((e,i) => {
            const t = TYPE_PALETTE[e.category] || TYPE_PALETTE.other;
            const editing = editId === e.id;
            return (
              <div key={e.id} style={{borderTop: i? "1px solid "+C.bgSubtle : "none", padding:editing?"14px 16px":"0"}}>
                {editing ? (
                  renderExpenseForm(editForm, ue, commitEdit, ()=>setEditId(null), "Save")
                ) : (
                  <div onClick={()=>startEdit(e)}
                    style={{display:"flex", alignItems:"center", gap:12, padding:"12px 16px", cursor:"pointer"}}>
                    <div style={{minWidth:0, flex:1}}>
                      <div style={{fontSize:14, fontWeight:500, color:C.text, fontFamily:F, letterSpacing:"-0.005em",
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{e.description}</div>
                      <div style={{display:"flex", gap:8, alignItems:"center", marginTop:5, flexWrap:"wrap"}}>
                        <TypePill type={e.category||"other"} />
                        <span style={{fontSize:12, color:C.textMuted, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>
                          {e.date ? new Date(e.date+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : ""}
                        </span>
                        {e.contractor && <span style={{fontSize:12, color:C.textMuted, fontFamily:F}}>· {e.contractor}</span>}
                        {e.fromFollowup && <span style={{fontSize:11, color:C.textMuted, fontFamily:F}}>· from follow-up</span>}
                      </div>
                    </div>
                    <div style={{fontSize:15, fontWeight:600, color:"#3f3f46", fontFamily:F, fontVariantNumeric:"tabular-nums", flexShrink:0}}>
                      {$(e.amount)}
                    </div>
                    <button onClick={ev=>{ev.stopPropagation(); del(e.id);}} aria-label="Delete expense"
                      {...btnStyle("ghost","sm", {color:C.textMuted, padding:"5px 6px"})}><I.trash size={14}/></button>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}

      {/* Add */}
      {adding ? (
        <SectionBlock title="New expense" color={C.green}>
          {renderExpenseForm(form, uf, commitAdd, ()=>{setForm(blank()); setAdding(false);}, "Add expense")}
        </SectionBlock>
      ) : (
        <button onClick={()=>setAdding(true)} {...btnStyle("secondary","md", {width:"100%"})}>
          <I.plus size={14}/> Add expense
        </button>
      )}
    </div>
  );
}

// -- Deals (curated wholesale list) -------------------------------------------
// Market filters are built dynamically from whatever states appear in the
// feed, so new pipeline markets show up here with zero client changes.

// Classify a deal against two pro forma strategies (buy-and-hold and fix-and-
// flip) and surface tags + scores so the card can show the right hero numbers.
// A deal can carry both tags ("multi-strategy") or neither (skipped from feed).
// Effective property-tax rates by state (annual % of value). Kept in sync
// with the matching table in functions/index.js — both classifiers must
// agree or the client will hide deals the server accepted (and vice versa).
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
const DEFAULT_TAX_RATE = 0.011;
// Homeowners-insurance effective annual rates (% of value) — coastal and
// hail-belt states run hot. Used to estimate insurance from the address.
const INSURANCE_RATES = {
  FL:0.0110, LA:0.0120, OK:0.0100, KS:0.0090, TX:0.0085, MS:0.0090,
  AL:0.0080, AR:0.0085, NE:0.0090, CO:0.0075, MO:0.0075, SC:0.0070,
  GA:0.0060, TN:0.0060, OH:0.0045, MI:0.0050, IN:0.0050, PA:0.0040,
  NY:0.0040, NJ:0.0040, IL:0.0050, WI:0.0040, MN:0.0055, KY:0.0060,
  NC:0.0060, VA:0.0045, MD:0.0040, CA:0.0045, WA:0.0040, OR:0.0040,
};
const DEFAULT_INS_RATE = 0.0055;

const classifyDeal = (deal) => {
  // Rent — 1% rule fallback capped at $2,200 so a $400k property doesn't
  // assume $4,000/mo rent (which would auto-pass even mediocre listings).
  const rent       = deal.rent && deal.rent > 0
    ? deal.rent
    : Math.min(2200, Math.round((deal.price || 0) * 0.01));
  // ARV — prefer scraped, else 30% margin over asking.
  const arv        = deal.arv && deal.arv > 0 ? deal.arv : Math.round((deal.price || 0) * 1.30);
  // Repair budget — wholesale needs work; assume 15% of ARV when not provided.
  const repair     = deal.repair && deal.repair > 0 ? deal.repair : Math.round(arv * 0.15);
  // State-specific tax — was hardcoded to Ohio's 2.33% on every deal.
  const taxRate    = STATE_TAX_RATES[deal.state] || DEFAULT_TAX_RATE;
  const monthlyTax = Math.round((deal.price * taxRate) / 12);

  const buyHoldInputs = {
    purchasePrice: deal.price || 0,
    repairCosts:   repair,
    rentAmount:    rent,
    expPropTax:    monthlyTax,
    expInsurance:  100,
    expManagement: Math.round(rent * 0.08), // 8% PM
    expUtilities:  0,
    vacancyRate:   5,
    downPaymentPct: 25,
    interestRate:  7.5,
    closingCosts:  DEFAULT_CLOSING,
    chosenStrategy:"finance",
  };
  const buyHold = calc(buyHoldInputs);

  // Fix-and-flip — ARV − total in − 8% selling − 6 months holding (taxes + ins).
  const totalIn      = (deal.price || 0) + repair;
  const agentFee     = arv * 0.06;
  const sellClosing  = arv * 0.02;
  const holdingCost  = 6 * (monthlyTax + 500);
  const flipProfit   = Math.round(arv - totalIn - agentFee - sellClosing - holdingCost);
  const flipROI      = totalIn > 0 ? (flipProfit / totalIn) * 100 : 0;

  // BRRRR — buy all-cash (price + rehab + closing), refinance at 75% of ARV
  // once stabilized, keep it as a rental on the refi loan. The play works
  // when the refi returns most of your capital AND the property still cash
  // flows against the new payment.
  const allIn        = (deal.price || 0) + repair + DEFAULT_CLOSING;
  const refiLoan     = Math.round(arv * 0.75);
  const capitalLeft  = Math.max(0, allIn - refiLoan);
  const recoveredPct = allIn > 0 ? Math.min(100, Math.round((refiLoan / allIn) * 100)) : 0;
  const refiMonthly  = 7.5 / 100 / 12; // same rate assumption as the buy-hold model
  const refiPmt      = Math.round(refiLoan * refiMonthly / (1 - Math.pow(1 + refiMonthly, -360)));
  const brrrrOpEx    = monthlyTax + 100 + Math.round(rent * 0.08) + Math.round(rent * 0.05);
  const brrrrCF      = rent - brrrrOpEx - refiPmt;

  // Tighter gates — no $30/mo cash-flow noise. Only "good" deals pass.
  // BRRRR additionally requires a real rehab (that's the second R) and is an
  // overlay tag: every brrrr deal is also in the feed via buyhold or flip.
  const tags = [];
  if (buyHold.finCap >= 8  && buyHold.finCF >= 200)   tags.push("buyhold");
  if (flipROI       >= 18 && flipProfit     >= 25000) tags.push("flip");
  if (repair >= 10000 && recoveredPct >= 70 && brrrrCF >= 100) tags.push("brrrr");

  // Score picks the "primary" strategy when both fit.
  const buyHoldScore = (buyHold.finCF >= 200 ? 30 : 0) + Math.min(buyHold.finCap, 15) * 2;
  const flipScore    = (flipROI       >= 18 ? 30 : 0) + Math.min(flipROI, 50);

  return {
    tags, buyHoldScore, flipScore,
    buyHold,
    flip: {arv, totalIn, profit:flipProfit, roi:flipROI},
    brrrr: {allIn, refiLoan, capitalLeft, recoveredPct, cashFlow: brrrrCF},
  };
};

// Inverse-ish of dealToProForma: shape an analyzer pro forma like a feed deal
// so it can live on the saved-deals watchlist and render in DealCard with the
// same classification pipeline as market deals.
const proFormaToFeedDeal = pf => ({
  id:            "a" + Date.now(),
  address:       pf.address || pf.fullAddress || "Untitled deal",
  streetAddress: pf.address || null,
  city: pf.city || "", state: pf.state || "", zip: pf.zip || "",
  lat: pf.lat || null, lng: pf.lng || null,
  type: pf.type || "Single Family",
  beds: pf.beds || 0, baths: pf.baths || 0, sqft: pf.sqft || 0,
  lotSize: pf.lotSize || 0,
  yearBuilt: pf.yearBuilt || 0,
  price:  pf.purchasePrice || 0,
  rent:   pf.rentAmount || pf.rentEstimate || 0,
  repair: pf.repairCosts || 0,
  arv:    pf.homeValueHigh || pf.flipSalePrice || pf.homeValueMedian || 0,
  photo: null, photos: [],
  alreadyOwned: !!pf.alreadyOwned,
  ownedLoanBalance: pf.ownedLoanBalance || 0,
  ownedLoanPayment: pf.ownedLoanPayment || 0,
  // Actual operating inputs at save time — Buy & Hold Projections and deal
  // reopens run on these instead of re-derived estimates.
  expPropTax:    pf.expPropTax    || 0,
  expInsurance:  pf.expInsurance  || 0,
  expManagement: pf.expManagement || 0,
  expUtilities:  pf.expUtilities  || 0,
  vacancyRate:   pf.vacancyRate ?? 5,
  otherIncome:   pf.otherIncome   || 0,
  source: "My analysis",
  sourcedAt: new Date().toISOString().slice(0, 10),
});

// Convert a curated deal record into the shape DealAnalyzer/portfolio expects.
const dealToProForma = (deal) => {
  // Prefer the real street address when the source has one (propwire, seibs).
  // Falls back to the generated title when not — InvestorLift hides street
  // addresses, so we get e.g. "5-bed Single Family in Fort Worth, TX".
  const addressForAnalyzer = deal.streetAddress || deal.address;
  return {
    ...newDeal(),
    // Keep the source deal's id so re-saving from the analyzer updates the
    // existing watchlist entry instead of duplicating it.
    ...(deal.id ? {id: deal.id} : {}),
    // A saved deal reopens exactly as it was saved: same purchase method
    // (Cash/Finance tab) and same exit scenario. Fresh feed deals without a
    // choice keep the newDeal default.
    ...(deal.chosenStrategy ? {chosenStrategy: deal.chosenStrategy}
      : deal.financing === "cash" ? {chosenStrategy: "cash"}
      : deal.financing === "finance" ? {chosenStrategy: "finance"} : {}),
    savedScenario: deal.scenario || null,
    ...(deal.alreadyOwned ? {alreadyOwned: true,
      ownedLoanBalance: deal.ownedLoanBalance || 0,
      ownedLoanPayment: deal.ownedLoanPayment || 0} : {}),
    address:      addressForAnalyzer,
    city:         deal.city,
    state:        deal.state,
    zip:          deal.zip,
    lat:          deal.lat,
    lng:          deal.lng,
    fullAddress:  `${addressForAnalyzer}, ${deal.city}, ${deal.state} ${deal.zip}`.trim(),
    type:         deal.type || "Single Family",
    beds:         deal.beds || 0,
    baths:        deal.baths || 0,
    sqft:         deal.sqft || 0,
    lotSize:      deal.lotSize || 0,
    yearBuilt:    deal.yearBuilt || 0,
    purchasePrice: deal.price || 0,
    repairCosts:   deal.repair || 0,
    rentAmount:    deal.rent || 0,
    rentEstimate:  deal.rent || 0,
    homeValueMedian: deal.arv || Math.round((deal.price||0) * 1.3),
    homeValueHigh:   deal.arv || Math.round((deal.price||0) * 1.35),
    homeValueLow:    Math.round((deal.arv || deal.price * 1.3) * 0.9),
    flipSalePrice:   deal.arv || Math.round((deal.price||0) * 1.35),
    expPropTax:      deal.expPropTax    || Math.round((deal.price || 0) * (STATE_TAX_RATES[deal.state] || DEFAULT_TAX_RATE) / 12),
    expInsurance:    deal.expInsurance  || 100,
    expManagement:   deal.expManagement ?? Math.round((deal.rent || 0) * 0.08),
    expUtilities:    deal.expUtilities  || 0,
    vacancyRate:     deal.vacancyRate ?? 5,
    otherIncome:     deal.otherIncome   || 0,
    // Photos the analyzer should display in its own carousel.
    photos:          [
      ...(Array.isArray(deal.userPhotos) ? deal.userPhotos : []),
      ...((Array.isArray(deal.photos) && deal.photos.length > 0)
        ? deal.photos
        : (deal.photo ? [deal.photo] : [])),
    ],
  };
};

// Sample deals — Phase 0 placeholder until the listings pipeline lands.
// Real lat/lng so Street View renders authentically per card.
// Property types that surface in the Deals feed. Residential 1–4 unit only —
// no commercial, no land, no mobile/manufactured, no 5+ unit apartment buildings.
// Strings line up with RentCast's `propertyType` taxonomy so the live pipeline
// can pass them straight through to this filter when Phase 1 lands.
const RESIDENTIAL_TYPES = new Set([
  "Single Family",
  "Multi-Family",  // RentCast lumps 2–4 unit duplex/triplex/fourplex here
  "Townhouse",
  "Condo",
]);
const isResidential = (deal) => RESIDENTIAL_TYPES.has(deal.type);

const SAMPLE_DEALS = [
  {id:"sd1",  market:"cle", address:"3214 W 65th Street",      city:"Cleveland",    state:"OH", zip:"44102",
   type:"Single Family", lat:41.4641, lng:-81.7345, beds:3, baths:1, sqft:1240, yearBuilt:1922,
   price:79900,  repair:18000, rent:1150, arv:142000, source:"Public listings", sourcedAt:"2026-05-25"},
  {id:"sd2",  market:"cle", address:"4128 East 116th Street",  city:"Cleveland",    state:"OH", zip:"44105",
   type:"Multi-Family", lat:41.4596, lng:-81.6133, beds:4, baths:2, sqft:1560, yearBuilt:1918,
   price:62500,  repair:42000, rent:1300, arv:158000, source:"Auction.com", sourcedAt:"2026-05-25"},
  {id:"sd3",  market:"cle", address:"1429 West 95th Street",   city:"Cleveland",    state:"OH", zip:"44102",
   type:"Single Family", lat:41.4866, lng:-81.7560, beds:3, baths:2, sqft:1380, yearBuilt:1925,
   price:115000, repair:8000,  rent:1450, arv:152000, source:"Public listings", sourcedAt:"2026-05-25"},
  {id:"sd4",  market:"det", address:"15843 Mansfield Street",  city:"Detroit",      state:"MI", zip:"48227",
   type:"Single Family", lat:42.4002, lng:-83.2034, beds:3, baths:1, sqft:1180, yearBuilt:1948,
   price:52000,  repair:28000, rent:1150, arv:118000, source:"Sheriff Sale", sourcedAt:"2026-05-25"},
  {id:"sd5",  market:"det", address:"19211 Strathmoor Street", city:"Detroit",      state:"MI", zip:"48235",
   type:"Multi-Family", lat:42.4366, lng:-83.1958, beds:4, baths:2, sqft:1540, yearBuilt:1942,
   price:84500,  repair:12000, rent:1450, arv:135000, source:"Public listings", sourcedAt:"2026-05-25"},
  {id:"sd6",  market:"mem", address:"3447 Park Avenue",        city:"Memphis",      state:"TN", zip:"38111",
   type:"Single Family", lat:35.1241, lng:-89.9417, beds:3, baths:2, sqft:1320, yearBuilt:1955,
   price:78500,  repair:14000, rent:1200, arv:128000, source:"Public listings", sourcedAt:"2026-05-25"},
  {id:"sd7",  market:"mem", address:"1238 Tutwiler Avenue",    city:"Memphis",      state:"TN", zip:"38107",
   type:"Single Family", lat:35.1697, lng:-90.0148, beds:2, baths:1, sqft:980,  yearBuilt:1940,
   price:42000,  repair:24000, rent:925,  arv:88000,  source:"Auction.com", sourcedAt:"2026-05-25"},
  {id:"sd8",  market:"bhm", address:"5612 33rd Avenue North",  city:"Birmingham",   state:"AL", zip:"35207",
   type:"Single Family", lat:33.5616, lng:-86.8311, beds:3, baths:1, sqft:1100, yearBuilt:1952,
   price:48000,  repair:22000, rent:1050, arv:108000, source:"Public listings", sourcedAt:"2026-05-25"},
  {id:"sd9",  market:"ind", address:"821 N New Jersey Street", city:"Indianapolis", state:"IN", zip:"46202",
   type:"Single Family", lat:39.7794, lng:-86.1556, beds:3, baths:2, sqft:1380, yearBuilt:1908,
   price:124000, repair:18000, rent:1500, arv:182000, source:"Public listings", sourcedAt:"2026-05-25"},
  {id:"sd10", market:"ind", address:"4128 Carrollton Avenue",  city:"Indianapolis", state:"IN", zip:"46205",
   type:"Townhouse", lat:39.8266, lng:-86.1444, beds:2, baths:1, sqft:920,  yearBuilt:1925,
   price:75000,  repair:12000, rent:1100, arv:118000, source:"Public listings", sourcedAt:"2026-05-25"},
  {id:"sd11", market:"kcm", address:"4218 Bellefontaine Ave",  city:"Kansas City",  state:"MO", zip:"64130",
   type:"Single Family", lat:39.0488, lng:-94.5444, beds:3, baths:2, sqft:1180, yearBuilt:1948,
   price:58000,  repair:20000, rent:1100, arv:115000, source:"Public listings", sourcedAt:"2026-05-25"},
  {id:"sd12", market:"kcm", address:"3315 Wabash Avenue",      city:"Kansas City",  state:"MO", zip:"64109",
   type:"Multi-Family", lat:39.0697, lng:-94.5536, beds:4, baths:2, sqft:1620, yearBuilt:1915,
   price:95000,  repair:32000, rent:1400, arv:172000, source:"Auction.com", sourcedAt:"2026-05-25"},
];

const FREE_PREVIEW_COUNT = 5;
const STRATEGY_LABELS = {
  buyhold: {label:"Rental",       color:C.greenDark, bg:C.greenSubtle, border:C.greenBorder, dot:C.green},
  flip:    {label:"Fix & Flip",   color:C.amberDark, bg:C.amberSubtle, border:C.amberBorder, dot:C.amber},
  brrrr:   {label:"BRRRR",        color:C.blueDark,  bg:C.blueSubtle,  border:C.blueBorder,  dot:C.blue},
  wholesale:{label:"Wholesale",   color:C.sidebar,   bg:C.bgSubtle,    border:C.borderHover, dot:C.sidebarHover},
  multi:   {label:"Multi-strategy", color:C.purpleDark, bg:C.purpleSubtle, border:C.purpleBorder, dot:C.purple},
};

// Wholesale assignment deals come from the InvestorLift pull ("DealHive 1")
// and are the only ones that carry wholesaler/seller contact info. Used by
// the strategy filters on the feed and the saved-deals dashboard.
const isWholesaleDeal = d =>
  d?.source === "DealHive 1" ||
  !!(d?.seller && (d.seller.name || d.seller.company || d.seller.phone || d.seller.email));

// Shared strategy segmented control (Deals feed + Saved Deals dashboard).
// `counts` is optional {all, buyhold, flip, wholesale} to show per-tab counts.
function StrategySegments({value, onChange, counts}) {
  const tabs = [
    ["all",       "All"],
    ["buyhold",   "Rentals"],
    ["brrrr",     "BRRRR"],
    ["flip",      "Fix & Flip"],
    ["wholesale", "Wholesale"],
  ];
  return (
    <div style={{display:"flex", padding:3, background:C.bgSubtle,
      border:"1px solid "+C.border, borderRadius:C.r2, maxWidth:"100%", overflowX:"auto"}}>
      {tabs.map(([id, label]) => {
        const active = value === id;
        const n = counts?.[id];
        return (
          <button key={id} onClick={()=>onChange(id)}
            style={{
              padding:"5px 12px", borderRadius:C.r1, border:"none", cursor:"pointer",
              background: active ? C.card : "transparent",
              color: active ? C.text : C.textSub,
              fontWeight: active?600:500, fontSize:12, fontFamily:F,
              letterSpacing:"-0.005em",
              boxShadow: active ? C.sh1 : "none",
              transition:"background .12s, color .12s, box-shadow .12s",
              whiteSpace:"nowrap", display:"inline-flex", alignItems:"center", gap:6,
            }}>
            {label}
            {n != null && n > 0 && (
              <span style={{
                fontSize:10.5, fontWeight:700, fontVariantNumeric:"tabular-nums",
                background: active ? C.greenLight : C.border,
                color: active ? C.greenDark : C.textSub,
                borderRadius:9999, padding:"1px 6px",
              }}>{n}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
// Metrics for a saved/feed deal — shared by the dashboard card and the Deal
// View page so the two can never disagree. Analyzer saves carry an `analysis`
// snapshot (displayed verbatim); feed deals fall back to the classifier.
const dealHeroMetrics = (deal, savedScenario, savedFinancing) => {
  const c = classifyDeal(deal);
  // BRRRR is an overlay: it never drives the primary badge (that stays a
  // buyhold/flip/multi call) — it gets its own chip beside the primary.
  const coreTags = c.tags.filter(t => t !== "brrrr");
  const isBrrrr  = c.tags.includes("brrrr");
  const autoPrimary = coreTags.length > 1
    ? "multi"
    : coreTags.includes("buyhold") && c.flipScore <= c.buyHoldScore
      ? "buyhold"
      : coreTags.includes("flip") && c.flipScore > c.buyHoldScore
        ? "flip"
        : coreTags[0] || "buyhold";
  // A user-chosen scenario (from the save picker) overrides the automatic
  // badge and re-angles the hero numbers to that scenario, honoring their
  // cash-vs-finance choice for the rental math.
  const primary = savedScenario || autoPrimary;
  const strat = STRATEGY_LABELS[primary] || STRATEGY_LABELS.buyhold;
  const cashMode = savedFinancing === "cash" || savedFinancing === "owned";

  const a = savedScenario ? deal.analysis : null;
  // Cash the refi puts in your pocket beyond everything you spent (never
  // negative on the card — a shortfall just reads $0 in pocket).
  const brrrrInPocket = a ? Math.max((a.brrrrNetCash || 0) - (a.brrrrAllIn ?? a.oop ?? 0), 0) : 0;

  const heroNumber =
    primary === "flip"      ? (a
      ? {label:"Est. profit", value:$(a.flipProfit), color:cfC(a.flipProfit)}
      : {label:"Est. profit", value:$(c.flip.profit), color:cfC(c.flip.profit)})
  : primary === "brrrr"     ? (a
      ? {label:"Cash Flow", value:$mo(a.brrrrCF), color:cfC(a.brrrrCF)}
      : {label:"Cash Flow", value:$mo(c.brrrr.cashFlow), color:cfC(c.brrrr.cashFlow)})
  : primary === "wholesale" ? {label:"Spread", value:$(c.flip.arv - c.flip.totalIn), color:cfC(c.flip.arv - c.flip.totalIn)}
  : (a
      ? {label:"Cash flow", value:$mo(a.cashFlow), color:cfC(a.cashFlow)}
      : {label:"Cash flow", value:$mo(cashMode ? c.buyHold.cashCF : c.buyHold.finCF),
         color:cfC(cashMode ? c.buyHold.cashCF : c.buyHold.finCF)});

  const secondaryMetrics =
    primary === "flip"      ? (a
      ? [["ARV", $(a.arv)], ["ROI", pct(a.flipROI)], ["Total Spent", $(a.oop)]]
      : [["ARV",  $(c.flip.arv)], ["ROI",  pct(c.flip.roi)], ["Total Spent", $(c.flip.totalIn)]])
  : primary === "brrrr"     ? (a
      ? [["Out of Pocket", $(a.brrrrAllIn ?? a.oop), C.red],
         ["Cash Out Refi", $(a.brrrrNetCash), C.cashPos],
         ["Cash in Pocket", $(brrrrInPocket), C.cashPos]]
      : [["Capital back", c.brrrr.recoveredPct + "%"], ["Refi loan", $(c.brrrr.refiLoan)], ["Out of Pocket", $(c.brrrr.allIn), C.red]])
  : primary === "wholesale" ? [["ARV", $(c.flip.arv)], ["All in", $(c.flip.totalIn)], ["ROI", pct(c.flip.roi)]]
  : (a
      ? [["Cap rate", pct(a.capRate)], ["CoC", pct(a.coc), null, true], ["Total Spent", $(a.oop)]]
      : cashMode
        ? [["Cap rate", pct(c.buyHold.cashCap)], ["CoC", pct(c.buyHold.cashCoC), null, true], ["Total Spent", $(c.buyHold.cashOOP)]]
        : [["Cap rate", pct(c.buyHold.finCap)], ["CoC", pct(c.buyHold.finCoC), null, true], ["Down", $(c.buyHold.down)]]);

  return {c, isBrrrr, primary, strat, cashMode, heroNumber, secondaryMetrics};
};

function DealCard({deal, isPro, onAnalyze, onSave, onUpgrade, onOpen, mobile,
                    saveLabel = "Save", saveIcon = null, saveAriaLabel = "Save to portfolio",
                    analyzeLabel = "Analyze", hideSource = false,
                    savedScenario = null, savedFinancing = null, showAddress = false}) {
  const {c, isBrrrr, strat, heroNumber, secondaryMetrics} =
    dealHeroMetrics(deal, savedScenario, savedFinancing);
  // Feed deals are pre-filtered upstream, so empty tags "shouldn't happen"
  // there — but user-filed watchlist deals (analyzer saves, manual entries)
  // can miss both pro forma gates. If the user chose a scenario at save time,
  // always render the card their way; only auto-classified feed cards bail.
  if (c.tags.length === 0 && !savedScenario) return null;

  const photo = (Array.isArray(deal.userPhotos) && deal.userPhotos[0])
    || deal.photo || (deal.lat && deal.lng ? svUrl(deal.lat, deal.lng, 800, 320) : null);

  // The user's own saved deals (showAddress) always get working card actions
  // and no Pro badge — the upgrade gate is for feed cards only.
  const unlocked = isPro || showAddress;
  const onPrimaryClick = unlocked ? onAnalyze : onUpgrade;
  const onSecondaryClick = unlocked ? onSave : onUpgrade;

  return (
    <Card hover style={{display:"flex", flexDirection:"column", cursor: onOpen ? "pointer" : "default"}}
      padding={0}
      onClick={onOpen ? () => onOpen(deal) : undefined}>
      {/* Photo + badges */}
      <div style={{position:"relative", height:170, background:C.bgSubtle, overflow:"hidden"}}>
        <SafeImg src={photo} fallback={imgPlaceholder()}
          style={{width:"100%", height:"100%", objectFit:"cover", display:"block"}}/>
        <div style={{position:"absolute", inset:0,
          background:"linear-gradient(to bottom, transparent 55%, rgba(9,9,11,.55))"}}/>
        <div style={{position:"absolute", top:10, left:10, right:10,
          display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8}}>
          <span style={{display:"inline-flex", alignItems:"center", gap:6, flexWrap:"wrap", minWidth:0}}>
            <span style={{
              display:"inline-flex", alignItems:"center", gap:5,
              background: strat.bg, color: strat.color, border:"1px solid "+strat.border,
              padding:"3px 9px", borderRadius:9999, fontSize:11, fontWeight:700, fontFamily:F,
              letterSpacing:"-0.005em", boxShadow: "0 1px 2px rgba(9,9,11,.15)",
            }}>
              <span style={{width:6, height:6, borderRadius:"50%", background:strat.dot}}/>
              {strat.label}
            </span>
            {savedFinancing ? (
              <span style={{
                display:"inline-flex", alignItems:"center", gap:5,
                background:"rgba(255,255,255,.95)", color:C.text, border:"1px solid "+C.border,
                padding:"3px 9px", borderRadius:9999, fontSize:11, fontWeight:700, fontFamily:F,
                letterSpacing:"-0.005em", boxShadow:"0 1px 2px rgba(9,9,11,.15)",
              }}>
                {savedFinancing === "owned" ? "Owned" : savedFinancing === "cash" ? "Cash" : "Finance"}
              </span>
            ) : isBrrrr && (
              <span style={{
                display:"inline-flex", alignItems:"center", gap:5,
                background: STRATEGY_LABELS.brrrr.bg, color: STRATEGY_LABELS.brrrr.color,
                border:"1px solid "+STRATEGY_LABELS.brrrr.border,
                padding:"3px 9px", borderRadius:9999, fontSize:11, fontWeight:700, fontFamily:F,
                letterSpacing:"-0.005em", boxShadow:"0 1px 2px rgba(9,9,11,.15)",
              }}>
                <span style={{width:6, height:6, borderRadius:"50%", background:STRATEGY_LABELS.brrrr.dot}}/>
                BRRRR
              </span>
            )}
          </span>
          {!unlocked && (
            <span title="Upgrade to see full details"
              style={{display:"inline-flex", alignItems:"center", gap:4,
                background:"rgba(9,9,11,.65)", color:"#fff", padding:"3px 8px",
                borderRadius:9999, fontSize:11, fontWeight:600, fontFamily:F,
                letterSpacing:"-0.005em"}}>
              <I.lock size={11} stroke={2.4}/> Pro
            </span>
          )}
        </div>
        <div style={{position:"absolute", bottom:10, left:14, right:14,
          color:"#fff", fontFamily:F, display:"flex", justifyContent:"space-between", alignItems:"flex-end", gap:8}}>
          <div style={{minWidth:0}}>
            <div style={{fontSize:18, fontWeight:700, letterSpacing:"-0.02em",
              fontVariantNumeric:"tabular-nums", lineHeight:1.1}}>{$(deal.price)}</div>
            <div style={{fontSize:12, color:"rgba(255,255,255,.85)", marginTop:2,
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
              {deal.city}, {deal.state}
            </div>
          </div>
          <span style={{
            background:"rgba(255,255,255,.92)", color:C.text,
            padding:"3px 8px", borderRadius:C.r1, fontSize:11, fontWeight:600,
            fontVariantNumeric:"tabular-nums", flexShrink:0, letterSpacing:"-0.005em",
          }}>
            {[
              deal.beds ? `${deal.beds}bd` : null,
              deal.baths ? `${deal.baths}ba` : null,
              deal.sqft ? `${(deal.sqft/1000).toFixed(1)}k sqft` : null,
            ].filter(Boolean).join(" · ") || "Details inside"}
          </span>
        </div>
      </div>

      <div style={{padding:"14px 16px", display:"flex", flexDirection:"column", gap:12, flex:1}}>
        {/* Address — gated */}
        <div>
          {(isPro || showAddress) ? (
            <div style={{fontSize:17.5, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.02em",
              textAlign:"center", lineHeight:1.3}}>
              {deal.address}
              {mobile && (deal.city || deal.state) && (
                <span>
                  {", "}{[deal.city, deal.state].filter(Boolean).join(", ")}
                </span>
              )}
            </div>
          ) : (
            <div style={{fontSize:13, color:C.textMuted, fontFamily:F, justifyContent:"center", width:"100%",
              display:"inline-flex", alignItems:"center", gap:6}}>
              <I.lock size={12} stroke={2.2}/> Address unlocked with Pro
            </div>
          )}
          {!mobile && (isPro || showAddress) && (deal.city || deal.state) && (
            <div style={{fontSize:17.5, color:C.text, fontFamily:F, marginTop:2, textAlign:"center", fontWeight:700, letterSpacing:"-0.02em"}}>
              {[deal.city, deal.state].filter(Boolean).join(", ")}
            </div>
          )}
          {!hideSource && (
            <div style={{fontSize:11, color:C.textMuted, fontFamily:F, marginTop:2}}>
              {deal.source} · {deal.sourcedAt ? new Date(deal.sourcedAt+"T00:00:00").toLocaleDateString("en-US", {month:"short", day:"numeric"}) : ""}
            </div>
          )}
          {/* Seller contact — Pro only, only when present on the deal */}
          {isPro && deal.seller && (deal.seller.phone || deal.seller.email) && (
            <div style={{marginTop:8, display:"flex", flexWrap:"wrap", gap:8, alignItems:"center"}}>
              {deal.seller.phone && (
                <a href={`tel:${deal.seller.phone}`} onClick={e=>e.stopPropagation()}
                  style={{fontSize:12, color:C.greenDark, fontFamily:F, fontWeight:600,
                    textDecoration:"none", display:"inline-flex", alignItems:"center", gap:5,
                    background:C.greenSubtle, border:"1px solid "+C.greenBorder,
                    padding:"3px 9px", borderRadius:9999}}>
                  <I.phone size={11} stroke={2.4}/> {deal.seller.phone}
                </a>
              )}
              {deal.seller.email && (
                <a href={`mailto:${deal.seller.email}`} onClick={e=>e.stopPropagation()}
                  style={{fontSize:12, color:C.blueDark, fontFamily:F, fontWeight:600,
                    textDecoration:"none", display:"inline-flex", alignItems:"center", gap:5,
                    background:C.blueSubtle, border:"1px solid "+C.blueBorder,
                    padding:"3px 9px", borderRadius:9999,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:200}}>
                  <I.message size={11} stroke={2.4}/> {deal.seller.email}
                </a>
              )}
            </div>
          )}
        </div>

        {/* Metrics — quadrant grid: hairline-divided white cells, colored
            indicator dots, everything centered. Same visual language as the
            deal modal's numbers table. */}
        <div style={{
          display:"grid", gridTemplateColumns:"1fr 1fr", gap:1,
          background:C.border, border:"1px solid "+C.border,
          borderRadius:C.r3, overflow:"hidden",
        }}>
          {[[heroNumber.label, heroNumber.value, heroNumber.color, false, true],
            ...secondaryMetrics.map(([l, v, vColor, keepCase]) => [l, v, vColor, keepCase, false])]
            .map(([l, v, vColor, keepCase, isHero]) => (
            <div key={l} style={{
              background:"linear-gradient(180deg, #fff 0%, #fcfcfd 100%)",
              padding:"13px 10px 15px", textAlign:"center",
            }}>
              <div style={{display:"inline-flex", alignItems:"center", gap:5,
                fontSize:10.5, color:C.textSub, fontWeight:700, fontFamily:F,
                letterSpacing:".07em", textTransform: keepCase ? "none" : "uppercase"}}>
                <span style={{width:5, height:5, borderRadius:"50%", flexShrink:0,
                  background: vColor || (isHero ? heroNumber.color : C.borderHover)}}/>
                {l}
              </div>
              <div style={{fontSize: isHero ? 21 : 18, fontWeight:500,
                color: vColor || (isHero ? heroNumber.color : C.text), fontFamily:F,
                fontVariantNumeric:"tabular-nums", letterSpacing:"-0.02em", marginTop:4}}>
                {v}
              </div>
            </div>
          ))}
        </div>

        {/* Actions — stopPropagation so the card-level onClick doesn't fire */}
        <div style={{display:"flex", gap:8, marginTop:"auto"}}
          onClick={e => e.stopPropagation()}>
          <button onClick={onPrimaryClick} {...btnStyle("primary","md", {flex:1})}>
            {unlocked ? <><I.search size={13}/> {analyzeLabel}</> : <><I.lock size={12} stroke={2.4}/> Unlock with Pro</>}
          </button>
          {unlocked && (
            <button onClick={onSecondaryClick} {...btnStyle("secondary","md")} aria-label={saveAriaLabel}>
              {saveIcon || <I.plus size={13}/>} {saveLabel}
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

// Detail modal — opens when a deal card is tapped. Pro members get the full
// description, ARV math, wholesaler info, and an outbound link to the source
// (InvestorLift, where they can request the actual address and contact the
// wholesaler). Free members see the photo, basic stats, and an upgrade CTA.
// Photo carousel with prev/next arrows, dots, counter, and touch-swipe. Falls
// back to a Street View image of the deal's lat/lng when no photos provided
// (handy for sample/RentCast deals that don't have hosted images).
function PhotoCarousel({photos = [], fallbackLat, fallbackLng, height = 280, mobile}) {
  const [index, setIndex] = useState(0);
  const touchX = useRef(null);

  const effective = (Array.isArray(photos) && photos.length > 0)
    ? photos
    : (fallbackLat && fallbackLng ? [svUrl(fallbackLat, fallbackLng, 1200, 480)] : []);
  const total = effective.length;

  // Clamp index if photos prop ever shrinks.
  useEffect(() => { if (index >= total) setIndex(0); }, [total, index]);

  if (total === 0) {
    return (
      <div style={{height, background:C.bgSubtle, display:"flex", alignItems:"center",
        justifyContent:"center", color:C.textMuted}}>
        <I.building size={36}/>
      </div>
    );
  }

  const goPrev = () => setIndex(i => (i - 1 + total) % total);
  const goNext = () => setIndex(i => (i + 1) % total);

  const onTouchStart = e => { touchX.current = e.touches[0].clientX; };
  const onTouchEnd   = e => {
    if (touchX.current == null) return;
    const dx = e.changedTouches[0].clientX - touchX.current;
    if (Math.abs(dx) > 40) (dx > 0 ? goPrev : goNext)();
    touchX.current = null;
  };

  const arrow = (side, icon, onClick, label) => (
    <button onClick={e => { e.stopPropagation(); onClick(); }} aria-label={label}
      style={{
        position:"absolute", top:"50%", [side]:12, transform:"translateY(-50%)",
        width:36, height:36, borderRadius:"50%",
        background:"rgba(255,255,255,.92)", border:"none", cursor:"pointer", color:C.text,
        display:"flex", alignItems:"center", justifyContent:"center", boxShadow:C.sh2,
        zIndex:2,
      }}>
      {icon}
    </button>
  );

  return (
    <div style={{position:"relative", height, overflow:"hidden", background:C.bgSubtle}}
      onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <SafeImg src={effective[index]} fallback={imgPlaceholder(36)}
        style={{width:"100%", height:"100%", objectFit:"cover", display:"block"}} />

      {total > 1 && (
        <>
          {/* Show arrows on desktop, hide on mobile where swipe is the primary UX */}
          {!mobile && (
            <>
              {arrow("left",  <I.chevronLeft  size={18}/>, goPrev, "Previous photo")}
              {arrow("right", <I.chevronRight size={18}/>, goNext, "Next photo")}
            </>
          )}

          {/* Counter pill top-right (offset from the close button) */}
          <div style={{
            position:"absolute", top:14, right: mobile ? 60 : 14,
            background:"rgba(9,9,11,.65)", color:"#fff",
            padding:"3px 9px", borderRadius:9999, fontSize:11, fontWeight:600,
            fontVariantNumeric:"tabular-nums", fontFamily:F,
            pointerEvents:"none", zIndex:2,
          }}>
            {index + 1} / {total}
          </div>

          {/* Dots */}
          <div style={{
            position:"absolute", bottom:10, left:0, right:0,
            display:"flex", justifyContent:"center", gap:6, zIndex:2,
          }}>
            {effective.map((_, i) => (
              <button key={i} onClick={e => { e.stopPropagation(); setIndex(i); }}
                aria-label={`Go to photo ${i + 1}`}
                style={{
                  width: i === index ? 22 : 7, height:7, borderRadius:9999,
                  background: i === index ? "#fff" : "rgba(255,255,255,.55)",
                  border:"none", cursor:"pointer", padding:0,
                  transition:"width .15s, background .15s",
                  boxShadow:"0 1px 2px rgba(9,9,11,.25)",
                }} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function DealDetailModal({deal, isPro, onClose, onAnalyze, onSave, onUpgrade, mobile}) {
  const c        = classifyDeal(deal);
  const coreTags = c.tags.filter(t => t !== "brrrr");
  const isBrrrr  = c.tags.includes("brrrr");
  const primary = coreTags.length > 1
    ? "multi"
    : coreTags.includes("buyhold") && c.flipScore <= c.buyHoldScore
      ? "buyhold"
      : coreTags.includes("flip") && c.flipScore > c.buyHoldScore
        ? "flip"
        : coreTags[0] || "buyhold";
  const strat = STRATEGY_LABELS[primary] || STRATEGY_LABELS.buyhold;

  // Escape closes; body scroll lock while open.
  useEffect(() => {
    lockBodyScroll();
    const handler = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => {
      unlockBodyScroll();
      window.removeEventListener("keydown", handler);
    };
  }, [onClose]);

  const arv    = deal.arv || Math.round((deal.price || 0) * 1.35);
  const spread = arv - (deal.price || 0) - (deal.repair || 0);
  const spreadPct = deal.price > 0 ? (spread / deal.price) * 100 : 0;

  const outerStyle = mobile
    ? {position:"fixed", inset:0, background:"rgba(9,9,11,.6)", zIndex:500,
       display:"flex", alignItems:"flex-end",
       backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)"}
    : {position:"fixed", inset:0, background:"rgba(9,9,11,.55)", zIndex:500,
       display:"flex", alignItems:"center", justifyContent:"center", padding:20,
       backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)"};
  const innerStyle = mobile
    ? {background:C.card, borderRadius:"18px 18px 0 0", width:"100%",
       maxHeight:"92dvh", overflowY:"auto", overscrollBehavior:"contain", boxShadow:C.sh4, WebkitOverflowScrolling:"touch"}
    : {background:C.card, borderRadius:C.r5, width:"100%", maxWidth:640,
       maxHeight:"92dvh", overflowY:"auto", overscrollBehavior:"contain", boxShadow:C.sh4, border:"1px solid "+C.border};

  const sectionPad = mobile ? "16px 18px" : "20px 24px";

  return (
    <div style={outerStyle} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={innerStyle}>
        {/* Hero — photo carousel with overlays */}
        <div style={{position:"relative"}}>
          <PhotoCarousel
            photos={Array.isArray(deal.photos) && deal.photos.length > 0
              ? deal.photos
              : (deal.photo ? [deal.photo] : [])}
            fallbackLat={deal.lat} fallbackLng={deal.lng}
            height={mobile ? 220 : 280}
            mobile={mobile} />
          {/* Dark gradient at the bottom so the price overlay stays legible */}
          <div style={{position:"absolute", inset:0, pointerEvents:"none",
            background:"linear-gradient(to bottom, transparent 50%, rgba(9,9,11,.55))"}}/>
          <button onClick={onClose} aria-label="Close"
            style={{position:"absolute", top:14, right:14, width:36, height:36, borderRadius:"50%",
              background:"rgba(255,255,255,.92)", border:"none", cursor:"pointer", color:C.text,
              display:"flex", alignItems:"center", justifyContent:"center", boxShadow:C.sh2,
              zIndex:3}}>
            <I.x size={16} stroke={2.5}/>
          </button>
          <div style={{position:"absolute", top:14, left:14, display:"flex", gap:6, flexWrap:"wrap", zIndex:3}}>
            <span style={{
              display:"inline-flex", alignItems:"center", gap:5,
              background:strat.bg, color:strat.color, border:"1px solid "+strat.border,
              padding:"4px 10px", borderRadius:9999, fontSize:11, fontWeight:700, fontFamily:F,
              letterSpacing:"-0.005em", boxShadow:"0 1px 2px rgba(9,9,11,.15)",
            }}>
              <span style={{width:6, height:6, borderRadius:"50%", background:strat.dot}}/>
              {strat.label}
            </span>
            {deal.hotness && (
              <span style={{
                display:"inline-flex", alignItems:"center", gap:5,
                background:C.redSubtle, color:C.redDark, border:"1px solid "+C.redBorder,
                padding:"4px 10px", borderRadius:9999, fontSize:11, fontWeight:700, fontFamily:F,
                letterSpacing:"-0.005em", boxShadow:"0 1px 2px rgba(9,9,11,.15)",
              }}>
                🔥 Hot
              </span>
            )}
            {deal.daysListed > 0 && deal.daysListed <= 7 && (
              <span style={{
                background:"rgba(9,9,11,.65)", color:"#fff",
                padding:"4px 10px", borderRadius:9999, fontSize:11, fontWeight:600, fontFamily:F,
                letterSpacing:"-0.005em",
              }}>
                New · {deal.daysListed}d ago
              </span>
            )}
          </div>
          {/* Bottom-left price overlay */}
          <div style={{position:"absolute", bottom:16, left:18, right:18, zIndex:3,
            display:"flex", justifyContent:"space-between", alignItems:"flex-end", gap:10, color:"#fff", fontFamily:F,
            pointerEvents:"none"}}>
            <div>
              <div style={{fontSize:11, color:"rgba(255,255,255,.85)", fontWeight:600, letterSpacing:".04em", textTransform:"uppercase"}}>
                Asking
              </div>
              <div style={{fontSize:28, fontWeight:700, letterSpacing:"-0.025em",
                fontVariantNumeric:"tabular-nums", lineHeight:1}}>{$(deal.price)}</div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:11, color:"rgba(255,255,255,.85)", fontWeight:600, letterSpacing:".04em", textTransform:"uppercase"}}>
                ARV
              </div>
              <div style={{fontSize:20, fontWeight:600, letterSpacing:"-0.02em",
                fontVariantNumeric:"tabular-nums"}}>{$(arv)}</div>
            </div>
          </div>
        </div>

        {/* Title + location */}
        <div style={{padding:sectionPad, borderBottom:"1px solid "+C.border}}>
          <h2 style={{margin:0, fontSize: mobile?17:19, fontWeight:700, color:C.text, fontFamily:F,
            letterSpacing:"-0.01em", lineHeight:1.3}}>
            {isPro
              ? (deal.address || `Off-market deal in ${deal.city}`)
              : `Off-market deal in ${deal.city}, ${deal.state}`}
          </h2>
          <div style={{display:"flex", alignItems:"center", gap:8, marginTop:6, flexWrap:"wrap"}}>
            <span style={{fontSize:13, color:C.textSub, fontFamily:F}}>
              {deal.city}{deal.state ? `, ${deal.state}` : ""}{isPro && deal.zip ? ` ${deal.zip}` : ""}
            </span>
            <span style={{color:C.textMuted}}>·</span>
            <span style={{fontSize:13, color:C.textMuted, fontFamily:F}}>
              {deal.source}
              {deal.sourcedAt && ` · Listed ${new Date(deal.sourcedAt+"T00:00:00").toLocaleDateString("en-US", {month:"short", day:"numeric"})}`}
            </span>
          </div>
        </div>

        {/* Quick stats */}
        <div style={{padding: mobile?"12px 18px":"14px 24px", borderBottom:"1px solid "+C.border,
          display:"grid", gridTemplateColumns: mobile?"repeat(2, 1fr)":"repeat(4, 1fr)", gap:14}}>
          {[
            ["Beds",   deal.beds || "—"],
            ["Baths",  deal.baths || "—"],
            ["Sqft",   deal.sqft ? deal.sqft.toLocaleString() : "—"],
            ["Year",   deal.yearBuilt || "—"],
            ["Type",   deal.type || "—"],
            ...(deal.condition ? [["Condition", deal.condition]] : []),
          ].map(([l, v]) => (
            <div key={l}>
              <div style={{fontSize:11.5, color:C.textSub, fontFamily:F, fontWeight:600,
                letterSpacing:".04em", textTransform:"uppercase"}}>{l}</div>
              <div style={{fontSize:14, fontWeight:600, color:C.text, fontFamily:F,
                fontVariantNumeric:"tabular-nums", marginTop:2,
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{v}</div>
            </div>
          ))}
        </div>

        {/* Spread / financials card */}
        <div style={{padding:sectionPad, borderBottom:"1px solid "+C.border}}>
          <div style={{fontSize:11, fontWeight:700, color:C.textSub, fontFamily:F,
            letterSpacing:".06em", textTransform:"uppercase", marginBottom:10}}>
            The numbers
          </div>
          <div style={{display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:0,
            border:"1px solid "+C.border, borderRadius:C.r3, overflow:"hidden",
            background:C.border}}>
            {[
              ["Asking price",  $(deal.price),   C.text],
              ["ARV estimate",  $(arv),          C.text],
              ["Potential spread", $(spread),    spread > 0 ? cfC(spread) : C.textMuted],
              ["Spread %",      pct(spreadPct),  spread > 0 ? cfC(spread) : C.textMuted],
            ].map(([l, v, color]) => (
              <div key={l} style={{padding:"12px 14px", background:C.card}}>
                <div style={{fontSize:11.5, color:C.textSub, fontFamily:F, fontWeight:600,
                  letterSpacing:".04em", textTransform:"uppercase"}}>{l}</div>
                <div style={{fontSize:16, fontWeight:700, color, fontFamily:F, marginTop:2,
                  fontVariantNumeric:"tabular-nums", letterSpacing:"-0.01em"}}>{v}</div>
              </div>
            ))}
          </div>
        </div>

        {/* BRRRR snapshot — buy all-cash, refi at 75% ARV, keep the rental */}
        {isBrrrr && (
          <div style={{padding:sectionPad, borderBottom:"1px solid "+C.border}}>
            <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:10}}>
              <span style={{fontSize:11, fontWeight:700, color:C.textSub, fontFamily:F,
                letterSpacing:".06em", textTransform:"uppercase"}}>
                BRRRR snapshot
              </span>
              <span style={{fontSize:10.5, fontWeight:700, fontFamily:F,
                background:STRATEGY_LABELS.brrrr.bg, color:STRATEGY_LABELS.brrrr.color,
                border:"1px solid "+STRATEGY_LABELS.brrrr.border,
                borderRadius:9999, padding:"1px 8px"}}>
                {c.brrrr.recoveredPct}% capital back at refi
              </span>
            </div>
            <div style={{display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:0,
              border:"1px solid "+C.border, borderRadius:C.r3, overflow:"hidden",
              background:C.border}}>
              {[
                ["All-in (cash + rehab)", $(c.brrrr.allIn),       C.text],
                ["Refi loan (75% ARV)",   $(c.brrrr.refiLoan),    C.text],
                ["Cash left in deal",     $(c.brrrr.capitalLeft), c.brrrr.capitalLeft <= 0 ? cfC(1) : C.text],
                ["Cash flow after refi",  $mo(c.brrrr.cashFlow),  cfC(c.brrrr.cashFlow)],
              ].map(([l, v, color]) => (
                <div key={l} style={{padding:"12px 14px", background:C.card}}>
                  <div style={{fontSize:11.5, color:C.textSub, fontFamily:F, fontWeight:600,
                    letterSpacing:".04em", textTransform:"uppercase"}}>{l}</div>
                  <div style={{fontSize:16, fontWeight:700, color, fontFamily:F, marginTop:2,
                    fontVariantNumeric:"tabular-nums", letterSpacing:"-0.01em"}}>{v}</div>
                </div>
              ))}
            </div>
            <p style={{fontSize:11.5, color:C.textMuted, fontFamily:F, margin:"8px 0 0", lineHeight:1.5}}>
              Model: purchase and rehab in cash, refinance at 75% of ARV (30yr, 7.5%), then hold as a rental.
            </p>
          </div>
        )}

        {/* Description — Pro only */}
        {deal.description && (
          <div style={{padding:sectionPad, borderBottom:"1px solid "+C.border}}>
            <div style={{fontSize:11, fontWeight:700, color:C.textSub, fontFamily:F,
              letterSpacing:".06em", textTransform:"uppercase", marginBottom:8}}>
              About this deal
            </div>
            {isPro ? (
              <div style={{fontSize:14, color:C.text, fontFamily:F, lineHeight:1.6, whiteSpace:"pre-wrap"}}>
                {deal.description}
              </div>
            ) : (
              <div style={{fontSize:13, color:C.textSub, fontFamily:F, lineHeight:1.6,
                background:C.bgSubtle, border:"1px dashed "+C.border, borderRadius:C.r2,
                padding:"12px 14px", display:"flex", alignItems:"center", gap:10}}>
                <I.lock size={14} stroke={2.2} style={{color:C.textMuted, flexShrink:0}}/>
                <span>Description and seller contact unlocked with DealHive Pro.</span>
              </div>
            )}
          </div>
        )}

        {/* Seller card — Pro members see the seller's name/company; free members
            see a teaser with an upgrade CTA. No outbound links. */}
        {(deal.seller?.company || deal.seller?.name || !isPro) && (
          <div style={{padding:sectionPad, borderBottom:"1px solid "+C.border}}>
            <div style={{fontSize:11, fontWeight:700, color:C.textSub, fontFamily:F,
              letterSpacing:".06em", textTransform:"uppercase", marginBottom:8}}>
              Seller
            </div>
            {isPro ? (
              <div style={{background:C.greenSubtle, border:"1px solid "+C.greenBorder, borderRadius:C.r3,
                padding:"14px 16px"}}>
                <div style={{display:"flex", alignItems:"center", gap:12}}>
                  <div style={{
                    width:42, height:42, borderRadius:"50%", background:C.card, border:"1px solid "+C.greenBorder,
                    color:C.greenDark, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0,
                    fontSize:15, fontWeight:700, fontFamily:F,
                  }}>
                    {(deal.seller?.company || deal.seller?.name || "?").charAt(0).toUpperCase()}
                  </div>
                  <div style={{minWidth:0, flex:1}}>
                    {deal.seller?.company && (
                      <div style={{fontSize:15, fontWeight:600, color:C.text, fontFamily:F, letterSpacing:"-0.005em",
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
                        {deal.seller.company}
                      </div>
                    )}
                    {deal.seller?.name && (
                      <div style={{fontSize:13, color:C.textSub, fontFamily:F, marginTop:2,
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
                        {deal.seller.name}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{background:C.greenSubtle, border:"1px solid "+C.greenBorder, borderRadius:C.r3,
                padding:"16px 18px", textAlign:"center"}}>
                <div style={{
                  width:42, height:42, borderRadius:"50%", background:C.green, color:"#fff",
                  display:"inline-flex", alignItems:"center", justifyContent:"center", marginBottom:8,
                }}>
                  <I.lock size={18} stroke={2.2}/>
                </div>
                <div style={{fontSize:15, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.005em"}}>
                  Unlock to see the seller
                </div>
                <div style={{fontSize:12, color:C.textSub, fontFamily:F, marginTop:4, lineHeight:1.5}}>
                  DealHive Pro members see the seller's contact details on every deal.
                </div>
                <button onClick={onUpgrade} {...btnStyle("primary","md", {marginTop:12, width:"100%"})}>
                  <I.star size={13}/> Upgrade to Pro
                </button>
              </div>
            )}
          </div>
        )}

        {/* Bottom actions */}
        <div style={{padding:sectionPad, display:"flex", gap:8, flexWrap:"wrap"}}>
          {isPro ? (
            <>
              <button onClick={() => { onAnalyze(deal); onClose(); }}
                {...btnStyle("primary","md", {flex:1})}>
                <I.search size={13}/> Analyze deal
              </button>
              <button onClick={() => { onSave(deal); onClose(); }}
                {...btnStyle("secondary","md", {flex:1})}>
                <I.plus size={13}/> Save to portfolio
              </button>
            </>
          ) : (
            <button onClick={onUpgrade} {...btnStyle("primary","md", {width:"100%"})}>
              <I.lock size={13} stroke={2.4}/> Unlock with Pro
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Dashboard for regular members (non-admin) — replaces the portfolio dashboard.
// Shows the member's saved deals as a watchlist with the same card/modal as
// the Deals page, but the secondary action is "Remove" instead of "Save".
// Save picker: choose which scenario a deal is saved under (Rentals, BRRRR,
// Fix & Flip, Wholesale) and whether you'd run it cash or financed. Renders
// above DealDetailModal (zIndex 600 vs 500) since Save also lives inside it.
function SaveDealSheet({deal, suggestedOverride, onCancel, onConfirm, mobile}) {
  const c = classifyDeal(deal);
  // The analyzer passes an explicit suggestion (whatever section the user had
  // open); market saves fall back to the automatic classification.
  const suggested = suggestedOverride || (isWholesaleDeal(deal) ? "wholesale"
    : c.tags.includes("buyhold") ? "buyhold"
    : c.tags.includes("flip")    ? "flip"
    : c.tags.includes("brrrr")   ? "brrrr"
    : "buyhold");
  const [scenario,  setScenario]  = useState(suggested);
  const [financing, setFinancing] = useState(deal.chosenStrategy === "cash" ? "cash" : "finance");
  // null | "dupe" | "saved" — saved shows a confirmation panel, then closes.
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (result !== "saved" && result !== "updated") return;
    const t = setTimeout(onCancel, 1400);
    return () => clearTimeout(t);
  }, [result, onCancel]);

  // Escape closes only this sheet — capture phase beats the modal's listener.
  useEffect(() => {
    lockBodyScroll();
    const handler = e => {
      if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
    };
    window.addEventListener("keydown", handler, true);
    return () => {
      unlockBodyScroll();
      window.removeEventListener("keydown", handler, true);
    };
  }, [onCancel]);

  const options = [
    {id:"buyhold",   Icon:I.building, label:"Rentals",     line:"Hold it, rent it, cash flow"},
    {id:"brrrr",     Icon:I.cycle,    label:"BRRRR",       line:"Rehab, rent, refi, repeat"},
    {id:"flip",      Icon:I.chart,    label:"Fix & Flip",  line:"Renovate and resell"},
    {id:"wholesale", Icon:I.star,     label:"Wholesale",   line:"Assign the contract"},
  ];

  const outerStyle = mobile
    ? {position:"fixed", inset:0, background:"rgba(9,9,11,.6)", zIndex:600,
       display:"flex", alignItems:"flex-end",
       backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)"}
    : {position:"fixed", inset:0, background:"rgba(9,9,11,.55)", zIndex:600,
       display:"flex", alignItems:"center", justifyContent:"center", padding:20,
       backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)"};
  const innerStyle = mobile
    ? {background:C.card, borderRadius:"18px 18px 0 0", width:"100%",
       maxHeight:"88dvh", overflowY:"auto", boxShadow:C.sh4, padding:"20px 18px 28px"}
    : {background:C.card, borderRadius:C.r5, width:"100%", maxWidth:480,
       boxShadow:C.sh4, border:"1px solid "+C.border, padding:"22px 24px"};

  if (result === "saved" || result === "updated") {
    const label = (STRATEGY_LABELS[scenario] || STRATEGY_LABELS.buyhold).label;
    return (
      <div style={outerStyle} onClick={e => e.target === e.currentTarget && onCancel()}>
        <div style={{...innerStyle, textAlign:"center", padding: mobile ? "40px 24px 52px" : "44px 32px"}}>
          <div style={{
            width:60, height:60, borderRadius:"50%", margin:"0 auto 16px",
            background:C.greenLight, border:"2px solid "+C.green, color:C.greenDark,
            display:"flex", alignItems:"center", justifyContent:"center",
          }}>
            <I.check size={28} stroke={2.4}/>
          </div>
          <div style={{fontSize:19, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.015em"}}>
            {result === "updated" ? `Updated in ${label}` : `Saved to ${label}`}
          </div>
          <div style={{fontSize:13.5, color:C.textSub, fontFamily:F, marginTop:4}}>
            {financing === "cash" ? "Cash" : "Finance"} · it's waiting on your Dashboard
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={outerStyle} onClick={e => e.target === e.currentTarget && onCancel()}>
      <div style={innerStyle}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12, marginBottom:4}}>
          <div style={{minWidth:0}}>
            <div style={{fontSize:18, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.015em"}}>
              Save this deal
            </div>
            <div style={{fontSize:13, color:C.textSub, fontFamily:F, marginTop:2,
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
              {deal.address}
            </div>
          </div>
          <button onClick={onCancel} aria-label="Close"
            style={{width:32, height:32, borderRadius:"50%", background:C.bgSubtle, border:"none",
              cursor:"pointer", color:C.textSub, display:"flex", alignItems:"center",
              justifyContent:"center", flexShrink:0}}>
            <I.x size={15}/>
          </button>
        </div>

        <div style={{fontSize:11, fontWeight:700, color:C.textSub, fontFamily:F,
          letterSpacing:".06em", textTransform:"uppercase", margin:"16px 0 8px"}}>
          Save as
        </div>
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>
          {options.map(({id, Icon, label, line}) => {
            const active = scenario === id;
            return (
              <button key={id} onClick={()=>setScenario(id)} aria-pressed={active}
                style={{
                  display:"flex", flexDirection:"column", alignItems:"flex-start", gap:6,
                  textAlign:"left", padding:"12px 13px", cursor:"pointer",
                  background: active ? C.greenSubtle : C.card,
                  border:"1.5px solid "+(active ? C.green : C.border),
                  borderRadius:C.r3, transition:"border-color .12s, background .12s",
                }}>
                <span style={{
                  width:30, height:30, borderRadius:C.r2,
                  background: active ? C.green : C.bgSubtle,
                  color: active ? "#fff" : C.textSub,
                  display:"inline-flex", alignItems:"center", justifyContent:"center",
                  transition:"background .12s, color .12s",
                }}>
                  <Icon size={15}/>
                </span>
                <span>
                  <span style={{display:"block", fontSize:13.5, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.01em"}}>
                    {label}
                    {id === suggested && (
                      <span style={{marginLeft:6, fontSize:10, fontWeight:700, color:C.greenDark,
                        background:C.greenLight, borderRadius:9999, padding:"1px 7px",
                        verticalAlign:"1px"}}>Suggested</span>
                    )}
                  </span>
                  <span style={{display:"block", fontSize:11.5, color:C.textSub, fontFamily:F, marginTop:1}}>{line}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div style={{fontSize:11, fontWeight:700, color:C.textSub, fontFamily:F,
          letterSpacing:".06em", textTransform:"uppercase", margin:"18px 0 8px"}}>
          How would you buy it?
        </div>
        <div style={{display:"flex", padding:3, background:C.bgSubtle,
          border:"1px solid "+C.border, borderRadius:C.r2}}>
          {[["finance","Finance"],["cash","Cash"]].map(([id,label]) => {
            const active = financing === id;
            return (
              <button key={id} onClick={()=>setFinancing(id)}
                style={{
                  flex:1, padding:"8px 12px", borderRadius:C.r1, border:"none", cursor:"pointer",
                  background: active ? C.card : "transparent",
                  color: active ? C.text : C.textSub,
                  fontWeight: active?600:500, fontSize:13, fontFamily:F,
                  boxShadow: active ? C.sh1 : "none",
                  transition:"background .12s, color .12s, box-shadow .12s",
                }}>{label}</button>
            );
          })}
        </div>

        {result === "dupe" && (
          <div style={{display:"flex", alignItems:"center", gap:8, marginTop:14,
            background:C.amberSubtle, border:"1px solid "+C.amberBorder, borderRadius:C.r2,
            padding:"10px 12px", fontSize:13, color:C.amberDark, fontFamily:F}}>
            <I.alert size={14}/> This deal is already in your saved deals.
          </div>
        )}
        {result === "limit" && (
          <div style={{display:"flex", alignItems:"flex-start", gap:8, marginTop:14,
            background:C.amberSubtle, border:"1px solid "+C.amberBorder, borderRadius:C.r2,
            padding:"10px 12px", fontSize:13, color:C.amberDark, fontFamily:F, lineHeight:1.5}}>
            <I.alert size={14} style={{flexShrink:0, marginTop:1}}/>
            <span>The Free plan holds 15 saved deals. Upgrade to Pro in Settings for unlimited saves.</span>
          </div>
        )}
        <button onClick={()=>{ const r = onConfirm(scenario, financing); setResult(r === "updated" ? "updated" : r === "limit" ? "limit" : r ? "saved" : "dupe"); }}
          {...btnStyle("primary","lg", {width:"100%", justifyContent:"center", marginTop: result === "dupe" ? 12 : 18})}>
          <I.star size={14}/> Save deal
        </button>
      </div>
    </div>
  );
}

// Scenario cards on the member home. They ARE the watchlist filter: click
// Rentals and the saved-deals grid below shows only your saved rentals.
// Click the active card again to go back to all. Counts show how many of
// your saved deals fit each scenario.
function StrategyCards({active, counts, onSelect, mobile}) {
  const cards = [
    {id:"buyhold",   Icon:I.building, title:"Rentals",     line:"Cash-flowing buy and holds"},
    {id:"brrrr",     Icon:I.cycle,    title:"BRRRR",       line:"Rehab, rent, refi, repeat"},
    {id:"flip",      Icon:I.chart,    title:"Fix & Flips", line:"Profit and ROI already sized"},
    {id:"wholesale", Icon:I.star,     title:"Wholesale",   line:"Assignments with seller contact"},
  ];
  return (
    <div style={{display:"grid", gap:12, marginBottom:20,
      gridTemplateColumns: mobile ? "1fr" : "repeat(auto-fit, minmax(215px, 1fr))"}}>
      {cards.map(({id, Icon, title, line}) => {
        const isActive = active === id;
        const n = counts?.[id] ?? 0;
        return (
          <button key={id} onClick={()=>onSelect(isActive ? "all" : id)}
            aria-pressed={isActive}
            style={{
              display:"flex", alignItems:"center", gap:12, textAlign:"left",
              background: isActive ? C.greenSubtle : C.card,
              border:"1.5px solid "+(isActive ? C.green : C.border),
              borderRadius:C.r4, padding:"14px 16px", cursor:"pointer",
              boxShadow: isActive ? C.sh3 : C.sh1,
              transition:"border-color .12s, box-shadow .12s, background .12s",
            }}
            onMouseEnter={e=>{ if(!isActive){ e.currentTarget.style.borderColor=C.greenBorder; e.currentTarget.style.boxShadow=C.sh3; } }}
            onMouseLeave={e=>{ if(!isActive){ e.currentTarget.style.borderColor=C.border; e.currentTarget.style.boxShadow=C.sh1; } }}>
            <span style={{
              width:38, height:38, borderRadius:C.r2, flexShrink:0,
              background: isActive ? C.green : C.greenSubtle,
              border:"1px solid "+(isActive ? C.green : C.greenBorder),
              color: isActive ? "#fff" : C.greenDark,
              display:"inline-flex", alignItems:"center", justifyContent:"center",
              transition:"background .12s, color .12s",
            }}>
              <Icon size={17}/>
            </span>
            <span style={{minWidth:0}}>
              <span style={{display:"block", fontSize:14, fontWeight:700, color:C.text,
                fontFamily:F, letterSpacing:"-0.01em"}}>{title}</span>
              <span style={{display:"block", fontSize:12, color:C.textSub, fontFamily:F, marginTop:1}}>
                {line}
              </span>
            </span>
            <span style={{
              marginLeft:"auto", flexShrink:0, fontFamily:F,
              fontSize:12, fontWeight:700, fontVariantNumeric:"tabular-nums",
              background: isActive ? C.green : C.bgSubtle,
              color: isActive ? "#fff" : C.textSub,
              border:"1px solid "+(isActive ? C.green : C.border),
              borderRadius:9999, padding:"3px 9px",
            }}>{n}</span>
          </button>
        );
      })}
    </div>
  );
}

// Property showcase for saved deals: photos, facts, and the map — no deal
// numbers (those live on the card and in the analyzer). Free accounts see up
// to 5 photos; Pro unlocks the full set.
function MiniMap({lat, lng}) {
  const ref = useRef(null);
  useEffect(() => {
    if (!lat || !lng || !ref.current) return;
    let map;
    const init = () => {
      if (!ref.current || map) return;
      map = window.L.map(ref.current, {zoomControl:false, attributionControl:false, scrollWheelZoom:false, dragging:false});
      map.setView([lat, lng], 15);
      window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);
      window.L.circleMarker([lat, lng], {radius:9, color:"#E8731C", weight:3, fillColor:"#E8731C", fillOpacity:.35}).addTo(map);
    };
    if (window.L) init();
    else {
      const sc = document.createElement("script");
      sc.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
      sc.onload = init;
      document.head.appendChild(sc);
      if (!document.querySelector('link[href*="leaflet.min.css"]')) {
        const l = document.createElement("link");
        l.rel = "stylesheet";
        l.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
        document.head.appendChild(l);
      }
    }
    return () => { if (map) map.remove(); };
  }, [lat, lng]);
  return <div ref={ref} style={{height:180, borderRadius:C.r3, overflow:"hidden", border:"1px solid "+C.border}}/>;
}

function PropertyModal({deal, isPro, onClose, onAnalyze, mobile}) {
  const photos = Array.isArray(deal.photos) && deal.photos.length
    ? deal.photos
    : (deal.lat && deal.lng ? svAngles(deal.lat, deal.lng) : (deal.photo ? [deal.photo] : []));
  const visible = isPro ? photos : photos.slice(0, 5);
  const locked  = photos.length - visible.length;
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    lockBodyScroll();
    const handler = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => {
      unlockBodyScroll();
      window.removeEventListener("keydown", handler);
    };
  }, [onClose]);

  const outerStyle = mobile
    ? {position:"fixed", inset:0, background:C.bg, zIndex:500}
    : {position:"fixed", inset:0, background:"rgba(9,9,11,.55)", zIndex:500,
       display:"flex", alignItems:"center", justifyContent:"center", padding:20,
       backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)"};
  const innerStyle = mobile
    ? {background:C.card, width:"100%", height:"100%",
       overflowY:"auto", overscrollBehavior:"contain", WebkitOverflowScrolling:"touch"}
    : {background:C.card, borderRadius:C.r5, width:"100%", maxWidth:620,
       maxHeight:"92dvh", overflowY:"auto", overscrollBehavior:"contain", boxShadow:C.sh4, border:"1px solid "+C.border};

  const mapsHref  = deal.lat && deal.lng
    ? `https://maps.google.com/?q=${deal.lat},${deal.lng}`
    : `https://maps.google.com/?q=${encodeURIComponent([deal.address, deal.city, deal.state].filter(Boolean).join(", "))}`;
  const zillowHref = `https://www.zillow.com/homes/${encodeURIComponent([deal.address, deal.city, deal.state, deal.zip].filter(Boolean).join(" "))}_rb/`;

  return (
    <div style={outerStyle} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={innerStyle}>
        {/* Gallery */}
        <div style={{position:"relative", background:C.bgSubtle}}>
          <div style={{height: mobile ? 240 : 300, overflow:"hidden"}}>
            <SafeImg src={visible[idx] || visible[0]} fallback={imgPlaceholder(36)}
              style={{width:"100%", height:"100%", objectFit:"cover", display:"block"}}/>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{position:"absolute", top:"calc(14px + env(safe-area-inset-top, 0px))", right:14, width:38, height:38, borderRadius:"50%",
              background:"rgba(255,255,255,.94)", border:"none", cursor:"pointer", color:C.text,
              display:"flex", alignItems:"center", justifyContent:"center", boxShadow:C.sh3}}>
            <I.x size={17}/>
          </button>
          {visible.length > 1 && (
            <div style={{position:"absolute", bottom:12, right:12, background:"rgba(9,9,11,.65)",
              color:"#fff", padding:"3px 10px", borderRadius:9999, fontSize:11.5, fontWeight:700,
              fontFamily:F, fontVariantNumeric:"tabular-nums"}}>
              {idx+1} / {visible.length}
            </div>
          )}
        </div>
        {(visible.length > 1 || locked > 0) && (
          <div style={{display:"flex", gap:8, padding:"12px 16px 4px", overflowX:"auto"}}>
            {visible.map((src, i) => (
              <button key={i} onClick={()=>setIdx(i)}
                style={{width:64, height:46, borderRadius:8, overflow:"hidden", padding:0, flexShrink:0,
                  border: i === idx ? "2px solid "+C.green : "1px solid "+C.border,
                  cursor:"pointer", background:C.bgSubtle}}>
                <SafeImg src={src.replace("size=900x560","size=200x140")} fallback={imgPlaceholder(14)}
                  style={{width:"100%", height:"100%", objectFit:"cover", display:"block"}}/>
              </button>
            ))}
            {locked > 0 && (
              <div title="Unlock all photos with Pro"
                style={{width:64, height:46, borderRadius:8, flexShrink:0,
                  border:"1px dashed "+C.greenBorder, background:C.greenSubtle,
                  display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
                  color:C.greenDark, fontSize:10, fontWeight:800, fontFamily:F, gap:2}}>
                <I.lock size={13} stroke={2.4}/> +{locked} Pro
              </div>
            )}
          </div>
        )}

        {/* Address hero */}
        <div style={{padding:"16px 20px 4px", textAlign:"center"}}>
          <div style={{fontSize:20, fontWeight:800, color:C.text, fontFamily:F, letterSpacing:"-0.02em"}}>
            {deal.address}
          </div>
          {(deal.city || deal.state) && (
            <div style={{fontSize:13.5, color:C.textSub, fontFamily:F, fontWeight:500, marginTop:2}}>
              {[deal.city, [deal.state, deal.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")}
            </div>
          )}
        </div>

        {/* Facts */}
        <div style={{padding:"14px 16px 0"}}>
          <div style={{display:"grid", gridTemplateColumns: mobile ? "repeat(2, 1fr)" : "repeat(3, 1fr)",
            gap:1, background:C.border, border:"1px solid "+C.border,
            borderRadius:C.r4, overflow:"hidden", boxShadow:C.sh1}}>
            {[
              ["Beds",     deal.beds || "—",  I.bed],
              ["Baths",    deal.baths || "—", I.bath],
              ["Sqft",     deal.sqft ? deal.sqft.toLocaleString() : "—", I.ruler],
              ["Lot Size", deal.lotSize ? deal.lotSize.toLocaleString() : "—", I.parcel],
              ["Year",     deal.yearBuilt || "—", I.calendar],
              ["Type",     deal.type || "—", I.home],
            ].map(([l, v, Ic]) => (
              <div key={l} style={{background:"linear-gradient(180deg, #fff 0%, #fbfbfc 100%)",
                padding:"12px 8px", textAlign:"center"}}>
                <div style={{width:30, height:30, borderRadius:8, margin:"0 auto 6px",
                  background:C.greenSubtle, border:"1px solid "+C.greenBorder, color:C.greenDark,
                  display:"flex", alignItems:"center", justifyContent:"center"}}>
                  <Ic size={14} stroke={2}/>
                </div>
                <div style={{fontSize:14.5, fontWeight:700, color:C.text, fontFamily:F,
                  fontVariantNumeric:"tabular-nums",
                  overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{v}</div>
                <div style={{fontSize:10.5, color:C.textSub, fontFamily:F, fontWeight:700,
                  letterSpacing:".06em", textTransform:"uppercase", marginTop:1}}>{l}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Map */}
        {deal.lat && deal.lng && (
          <div style={{padding:"14px 16px 0"}}>
            <MiniMap lat={deal.lat} lng={deal.lng}/>
          </div>
        )}

        {/* Actions */}
        <div style={{padding:"16px 16px 20px"}}>
          <button onClick={()=>{ onClose(); onAnalyze(deal); }}
            {...btnStyle("primary","lg", {width:"100%", justifyContent:"center"})}>
            <I.search size={15}/> Open Full Analysis
          </button>
          <div style={{display:"flex", gap:10, marginTop:10}}>
            <a href={mapsHref} target="_blank" rel="noreferrer"
              style={{flex:1, textDecoration:"none"}}>
              <span {...btnStyle("secondary","md", {width:"100%", justifyContent:"center"})}>
                <I.pin size={13}/> Open in Maps
              </span>
            </a>
            <a href={zillowHref} target="_blank" rel="noreferrer"
              style={{flex:1, textDecoration:"none"}}>
              <span {...btnStyle("secondary","md", {width:"100%", justifyContent:"center"})}>
                <I.externalLink size={13}/> View on Zillow
              </span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

// -- Deal View sub-sheets --------------------------------------------------------
// Shared bottom-sheet shell for the Deal View's research screens.
function SheetShell({title, sub, onClose, mobile, children}) {
  useEffect(() => {
    lockBodyScroll();
    const h = e => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => {
      unlockBodyScroll();
      window.removeEventListener("keydown", h, true);
    };
  }, [onClose]);
  const outer = mobile
    ? {position:"fixed", inset:0, background:C.card, zIndex:620}
    : {position:"fixed", inset:0, background:"rgba(9,9,11,.55)", zIndex:620,
       display:"flex", alignItems:"center", justifyContent:"center", padding:20,
       backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)"};
  const inner = mobile
    ? {background:C.card, width:"100%", height:"100%", overflowY:"auto", overscrollBehavior:"contain",
       padding:"calc(16px + env(safe-area-inset-top, 0px)) 16px 40px", WebkitOverflowScrolling:"touch"}
    : {background:C.card, borderRadius:C.r5, width:"100%", maxWidth:500, maxHeight:"86dvh",
       overflowY:"auto", overscrollBehavior:"contain", boxShadow:C.sh4, border:"1px solid "+C.border, padding:"22px 22px 24px"};
  return (
    <div style={outer} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={inner}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12, marginBottom:14}}>
          <div style={{minWidth:0}}>
            <div style={{fontSize:18, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.015em"}}>{title}</div>
            {sub && (
              <div style={{fontSize:12.5, color:C.textSub, fontFamily:F, marginTop:2,
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{sub}</div>
            )}
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{width:32, height:32, borderRadius:"50%", background:C.bgSubtle, border:"none",
              cursor:"pointer", color:C.textSub, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0}}>
            <I.x size={15}/>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// County-record fetch shared by Owner Lookup and Property Records. Uses the
// same cache key as the analyzer's property pull, so any address that's been
// analyzed opens instantly with no extra lookup spent.
function usePropertyRecord(deal, apiLookup, rcAuth, enabled = true) {
  const [st, setSt] = useState({loading: !!enabled, err: null, rec: null});
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    (async () => {
      try {
        if (!rcOk(rcAuth) || !apiLookup) throw new Error("unavailable");
        const key  = lookupKey("rc-detail", deal.address, deal.city, deal.state, deal.zip);
        const data = await apiLookup(key, () => rentcastFetch(deal.address, deal.city, deal.state, deal.zip, rcAuth));
        if (!alive) return;
        const rec = (data && data.property) || null;
        setSt({loading:false, err: rec ? null : "No county records found for this address yet.", rec});
      } catch (e) {
        if (!alive) return;
        setSt({loading:false, err: e && e.code === "CAP" ? LOOKUP_CAP_MSG : "Lookup failed. Try again in a moment.", rec:null});
      }
    })();
    return () => { alive = false; };
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return st;
}

const sheetSpinner = (text) => (
  <div style={{padding:"32px 0", textAlign:"center", color:C.textSub, fontSize:13.5, fontFamily:F}}>{text}</div>
);
const sheetError = (text) => (
  <div style={{display:"flex", gap:8, alignItems:"flex-start", background:C.redSubtle,
    border:"1px solid "+C.redBorder, borderRadius:C.r2, padding:"12px 14px",
    fontSize:13, color:C.redDark, fontFamily:F, lineHeight:1.55}}>
    <I.alert size={15} style={{flexShrink:0, marginTop:1}}/> {text}
  </div>
);

function OwnerLookupSheet({deal, isPro, apiLookup, rcAuth, onUpgrade, onClose, mobile}) {
  const st  = usePropertyRecord(deal, apiLookup, rcAuth, isPro);
  const rec = st.rec || {};
  const names = (rec.owner && Array.isArray(rec.owner.names) ? rec.owner.names : []).filter(Boolean);
  const mail  = rec.owner && rec.owner.mailingAddress;
  const mailStr = mail
    ? (mail.formattedAddress || [mail.addressLine1, mail.city,
        [mail.state, mail.zipCode].filter(Boolean).join(" ")].filter(Boolean).join(", "))
    : null;
  const occupied = rec.ownerOccupied === true;
  const absentee = rec.ownerOccupied === false;
  return (
    <SheetShell title="Owner Lookup" sub={`${deal.address}${deal.city ? `, ${deal.city}` : ""}`}
      onClose={onClose} mobile={mobile}>
      {!isPro ? (
        <div style={{textAlign:"center", padding:"10px 4px 4px"}}>
          <div style={{width:52, height:52, borderRadius:"50%", margin:"0 auto 12px",
            background:C.greenSubtle, border:"1px solid "+C.greenBorder, color:C.greenDark,
            display:"flex", alignItems:"center", justifyContent:"center"}}>
            <I.user size={22} stroke={2}/>
          </div>
          <div style={{fontSize:16, fontWeight:800, color:C.text, fontFamily:F, letterSpacing:"-0.015em"}}>
            Who owns this property?
          </div>
          <div style={{fontSize:13, color:C.textSub, fontFamily:F, lineHeight:1.6, marginTop:6, maxWidth:340, margin:"6px auto 0"}}>
            Pro reveals the owner's name, the mailing address where their tax bill goes,
            and whether they're an absentee owner — straight from county records.
          </div>
          {onUpgrade && (
            <button onClick={onUpgrade} {...btnStyle("primary","lg", {marginTop:16, justifyContent:"center", width:"100%"})}>
              <I.star size={14}/> Unlock with Pro
            </button>
          )}
        </div>
      ) : st.loading ? sheetSpinner("Pulling county records…")
        : st.err ? sheetError(st.err)
        : (
        <>
          <div style={{
            background:`linear-gradient(150deg, ${C.greenSubtle} 0%, #fff 80%)`,
            border:"1px solid "+C.greenBorder, borderRadius:C.r4,
            padding:"16px", textAlign:"center", boxShadow:C.sh1, marginBottom:14,
          }}>
            <div style={{fontSize:10.5, fontWeight:700, color:C.greenDark, fontFamily:F,
              letterSpacing:".07em", textTransform:"uppercase"}}>Owner of Record</div>
            <div style={{fontSize:19, fontWeight:800, color:C.text, fontFamily:F,
              letterSpacing:"-0.02em", marginTop:4, lineHeight:1.3}}>
              {names.length ? names.join(" & ") : "Not disclosed in records"}
            </div>
            {(absentee || occupied) && (
              <div style={{display:"inline-flex", alignItems:"center", gap:6, marginTop:8,
                padding:"3px 11px", borderRadius:9999, fontSize:11.5, fontWeight:700, fontFamily:F,
                background: absentee ? C.amberSubtle : C.greenSubtle,
                border: "1px solid " + (absentee ? C.amberBorder : C.greenBorder),
                color: absentee ? C.amberDark : C.greenDark}}>
                <span style={{width:6, height:6, borderRadius:"50%",
                  background: absentee ? C.amber : C.green}}/>
                {absentee ? "Absentee Owner" : "Owner Occupied"}
              </div>
            )}
          </div>
          {mailStr && <DataRow label="Mailing Address" value={mailStr} />}
          {rec.county && <DataRow label="County" value={rec.county} />}
          <div style={{fontSize:11.5, color:C.textMuted, fontFamily:F, lineHeight:1.55, marginTop:10}}>
            From county assessor records. Names can lag a recent sale by a few weeks.
            {absentee ? " Absentee owners are often the most open to offers." : ""}
          </div>
        </>
      )}
    </SheetShell>
  );
}

function RecordsSheet({deal, apiLookup, rcAuth, onClose, mobile}) {
  const st  = usePropertyRecord(deal, apiLookup, rcAuth, true);
  const rec = st.rec || {};
  const assess = rcLatestYear(rec.taxAssessments);
  const taxes  = rcLatestYear(rec.propertyTaxes);
  const saleDate = rec.lastSaleDate
    ? new Date(rec.lastSaleDate).toLocaleDateString("en-US", {month:"short", year:"numeric"})
    : null;
  return (
    <SheetShell title="Property Records" sub={`${deal.address}${deal.city ? `, ${deal.city}` : ""}`}
      onClose={onClose} mobile={mobile}>
      {st.loading ? sheetSpinner("Pulling county records…")
        : st.err ? sheetError(st.err)
        : (
        <>
          {(rec.lastSalePrice || saleDate) &&
            <DataRow label={`Last Sale${saleDate ? ` (${saleDate})` : ""}`}
              value={rec.lastSalePrice ? $(rec.lastSalePrice) : "Price not disclosed"} />}
          {assess && assess.value > 0 &&
            <DataRow label={`Assessed Value${assess.year ? ` (${assess.year})` : ""}`} value={$(assess.value)} />}
          {taxes && taxes.total > 0 &&
            <DataRow label={`Property Tax${taxes.year ? ` (${taxes.year})` : ""}`} value={$(taxes.total) + "/yr"} />}
          {(rec.assessorID || deal.parcelId) && <DataRow label="Parcel ID" value={rec.assessorID || deal.parcelId} />}
          {rec.county && <DataRow label="County" value={rec.county} />}
          {rec.zoning && <DataRow label="Zoning" value={rec.zoning} />}
          {(rec.yearBuilt || deal.yearBuilt) > 0 && <DataRow label="Year Built" value={rec.yearBuilt || deal.yearBuilt} />}
          {(rec.squareFootage || deal.sqft) > 0 && <DataRow label="Square Footage" value={(rec.squareFootage || deal.sqft).toLocaleString() + " sqft"} />}
          {(rec.lotSize || deal.lotSize) > 0 && <DataRow label="Lot Size" value={(rec.lotSize || deal.lotSize).toLocaleString() + " sqft"} />}
          {(rec.propertyType || deal.type) && <DataRow label="Property Type" value={rec.propertyType || deal.type} />}
          <div style={{fontSize:11.5, color:C.textMuted, fontFamily:F, lineHeight:1.55, marginTop:10}}>
            Public records from county assessor data. Figures update as counties publish.
          </div>
        </>
      )}
    </SheetShell>
  );
}

// Sales comps: RentCast's value AVM with its comparable sale listings — the
// actual comps the valuation model used, each with price and distance.
function SalesCompsSheet({deal, isPro, apiLookup, rcAuth, onUpgrade, onClose, mobile}) {
  const [st, setSt] = useState({loading:true, err:null, med:0, lo:0, hi:0, comps:[]});
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!rcOk(rcAuth) || !apiLookup) throw new Error("unavailable");
        const q   = encodeURIComponent(`${deal.address}, ${deal.city}, ${deal.state} ${deal.zip||""}`.trim());
        const key = lookupKey("rc-salescomps", deal.address, deal.city, deal.state, deal.zip);
        const val = await apiLookup(key, () => rcGet(`/avm/value?address=${q}&compCount=15`, rcAuth));
        if (!alive) return;
        const med = (val && val.price) || 0;
        setSt({
          loading:false,
          err: med ? null : "No value estimate found for this address.",
          med,
          lo: (val && val.priceRangeLow)  || (med ? Math.round(med*0.9) : 0),
          hi: (val && val.priceRangeHigh) || (med ? Math.round(med*1.1) : 0),
          comps: ((val && Array.isArray(val.comparables)) ? [...val.comparables] : [])
            .sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99)),
        });
      } catch (e) {
        if (!alive) return;
        setSt(x => ({...x, loading:false,
          err: e && e.code === "CAP" ? LOOKUP_CAP_MSG : "Value lookup failed. Try again in a moment."}));
      }
    })();
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = isPro ? st.comps : st.comps.slice(0, 5);
  const hidden  = st.comps.length - visible.length;
  const teaser  = hidden > 0 ? st.comps.slice(5, 7) : [];
  const row = (l, i) => {
    const priceV = l.price || 0;
    const psf    = l.squareFootage ? (priceV / l.squareFootage) : null;
    return (
      <div key={l.id || i} style={{
        display:"flex", justifyContent:"space-between", alignItems:"center", gap:12,
        border:"1px solid "+C.border, borderRadius:C.r3, padding:"12px 13px",
        background:"linear-gradient(180deg, #fff 0%, #fcfcfd 100%)", boxShadow:C.sh1,
      }}>
        <div style={{display:"flex", alignItems:"flex-start", gap:11, minWidth:0}}>
          <span style={{width:30, height:30, borderRadius:8, flexShrink:0, marginTop:1,
            background:C.blueSubtle, border:"1px solid "+C.blueBorder, color:C.blueDark,
            display:"inline-flex", alignItems:"center", justifyContent:"center",
            fontSize:11.5, fontWeight:800, fontFamily:F}}>{i+1}</span>
          <div style={{minWidth:0}}>
            <div style={{fontSize:13, fontWeight:650, color:C.text, fontFamily:F,
              lineHeight:1.35, letterSpacing:"-0.005em"}}>
              {l.formattedAddress || l.addressLine1 || "Nearby sale"}
            </div>
            <div style={{fontSize:11.5, color:C.textSub, fontFamily:F, marginTop:2}}>
              {(l.bedrooms||0)}bd · {(l.bathrooms||0)}ba{l.squareFootage ? ` · ${l.squareFootage.toLocaleString()} sqft` : ""}
            </div>
          </div>
        </div>
        <div style={{textAlign:"right", flexShrink:0}}>
          <div style={{fontSize:15, fontWeight:700, color:C.text, fontFamily:F,
            fontVariantNumeric:"tabular-nums", letterSpacing:"-0.01em"}}>
            {$(priceV)}
          </div>
          {psf && (
            <div style={{fontSize:10.5, color:C.textMuted, fontFamily:F, fontVariantNumeric:"tabular-nums", marginTop:1}}>
              ${Math.round(psf)}/sqft
            </div>
          )}
          {typeof l.distance === "number" && (
            <div style={{display:"inline-flex", alignItems:"center", marginTop:4,
              padding:"2px 8px", borderRadius:9999, background:C.bgSubtle,
              border:"1px solid "+C.border, fontSize:10, fontWeight:600,
              color:C.textSub, fontFamily:F, whiteSpace:"nowrap"}}>
              {l.distance.toFixed(2)} mi
            </div>
          )}
        </div>
      </div>
    );
  };
  return (
    <SheetShell title="Sales Comps & ARV" sub={`${deal.address}${deal.city ? `, ${deal.city}` : ""}`}
      onClose={onClose} mobile={mobile}>
      {st.loading ? sheetSpinner("Pulling comparable sales…")
        : st.err ? sheetError(st.err)
        : (
        <>
          <div style={{
            background:`linear-gradient(150deg, ${C.blueSubtle} 0%, #fff 80%)`,
            border:"1px solid "+C.blueBorder, borderRadius:C.r4,
            padding:"18px 16px", textAlign:"center", boxShadow:C.sh2,
          }}>
            <div style={{fontSize:10.5, fontWeight:700, color:C.blueDark, fontFamily:F,
              letterSpacing:".07em", textTransform:"uppercase"}}>Estimated Value</div>
            <div style={{fontSize:34, fontWeight:800, color:C.text, fontFamily:F,
              fontVariantNumeric:"tabular-nums", letterSpacing:"-0.03em", marginTop:3}}>
              {$(st.med)}
            </div>
            <div style={{display:"inline-flex", alignItems:"center", gap:6, marginTop:6,
              background:"#fff", border:"1px solid "+C.border, borderRadius:9999,
              padding:"4px 12px", fontSize:12, color:C.textSub, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>
              Range {$(st.lo)} – {$(st.hi)}
            </div>
            <div style={{fontSize:11.5, color:C.textMuted, fontFamily:F, marginTop:7, lineHeight:1.5}}>
              As-is value from comparable sales — set your ARV in the Deal Calculator.
            </div>
          </div>

          {st.comps.length > 0 && (
            <>
              <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline",
                margin:"20px 0 10px"}}>
                <span style={{fontSize:11, fontWeight:700, color:C.textSub, fontFamily:F,
                  letterSpacing:".06em", textTransform:"uppercase"}}>
                  Comparable Sales
                </span>
                <span style={{fontSize:11.5, color:C.textMuted, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>
                  {isPro ? st.comps.length : `showing ${visible.length} of ${st.comps.length}`}
                </span>
              </div>
              <div style={{display:"flex", flexDirection:"column", gap:8}}>
                {visible.map(row)}
              </div>
              {hidden > 0 && (
                <div style={{position:"relative", marginTop:8, borderRadius:C.r4, overflow:"hidden"}}>
                  <div aria-hidden="true" style={{display:"flex", flexDirection:"column", gap:8,
                    filter:"blur(6px)", opacity:.8, pointerEvents:"none", userSelect:"none"}}>
                    {teaser.map((l, i) => row(l, i + 5))}
                  </div>
                  <div style={{position:"absolute", inset:0, display:"flex", flexDirection:"column",
                    alignItems:"center", justifyContent:"center", gap:10, padding:"0 16px",
                    background:"linear-gradient(180deg, rgba(255,255,255,.5) 0%, rgba(255,255,255,.94) 100%)"}}>
                    <div style={{display:"inline-flex", alignItems:"center", gap:8,
                      fontSize:13.5, fontWeight:800, color:C.text, fontFamily:F, letterSpacing:"-0.01em"}}>
                      <span style={{width:26, height:26, borderRadius:"50%", flexShrink:0,
                        background:C.blueSubtle, border:"1px solid "+C.blueBorder, color:C.blueDark,
                        display:"inline-flex", alignItems:"center", justifyContent:"center"}}>
                        <I.lock size={12} stroke={2.6}/>
                      </span>
                      {hidden} more comparable sale{hidden===1?"":"s"}
                    </div>
                    {onUpgrade ? (
                      <button onClick={onUpgrade} {...btnStyle("primary","md")}>
                        <I.star size={13}/> Unlock with Pro
                      </button>
                    ) : (
                      <div style={{fontSize:12, color:C.textSub, fontFamily:F}}>
                        Upgrade to Pro in Settings to see them all.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </SheetShell>
  );
}

// Buy & Hold projection engine — single pass through every year up to the
// selected one, on the exact figures captured at save time (state-rate
// estimates back-fill older saves). Returns the selected year's statement
// plus cumulative cash flow, sale analysis, return metrics, and a true IRR.
function projectHold(deal, asm, year) {
  const price  = deal.price || 0;
  const snap   = deal.analysis || {};
  const vacPct = deal.vacancyRate ?? 5;
  const rent0  = (deal.rent || 0) * 12;
  const other0 = (deal.otherIncome || 0) * 12;
  const taxMo  = deal.expPropTax   || Math.round(price * (STATE_TAX_RATES[deal.state] || DEFAULT_TAX_RATE) / 12);
  const insMo  = deal.expInsurance || Math.round(price * (INSURANCE_RATES[deal.state] || DEFAULT_INS_RATE) / 12);
  const mgmtMo = deal.expManagement ?? Math.round((deal.rent || 0) * 0.08);
  const utilMo = deal.expUtilities || 0;
  const knownMo    = taxMo + insMo + mgmtMo + utilMo;
  const otherExpMo = Math.max((snap.expMo || knownMo) - knownMo, 0);
  const invested   = snap.oop ?? (price + (deal.repair || 0));

  let bal = snap.loanAmt || 0;
  const rM  = (snap.loanRate ?? 7.5) / 1200;
  const pmt = snap.mtgMo || 0;

  let cumCF = 0, out = null;
  const flows = [-invested];
  for (let y = 1; y <= year; y++) {
    const g  = Math.pow(1 + (asm.incomeGrowth  || 0) / 100, y - 1);
    const ge = Math.pow(1 + (asm.expenseGrowth || 0) / 100, y - 1);
    const rentYr  = rent0 * g;
    const otherYr = other0 * g;
    const gross   = rentYr + otherYr;
    const vacancy = gross * vacPct / 100;
    const opIncome = gross - vacancy;
    const lines = [
      ["Property Taxes",       taxMo  * 12 * ge],
      ["Insurance",            insMo  * 12 * ge],
      ["Property Management",  mgmtMo * 12 * ge],
      ["Maintenance",          (asm.maintenancePct || 0) / 100 * rentYr],
      ["Capital Expenditures", (asm.capexPct || 0) / 100 * rentYr],
      ["HOA Fees",             0],
      ["Utilities",            utilMo * 12 * ge],
      ["Landscaping",          0],
      ["Accounting & Legal",   0],
      ...(otherExpMo > 0 ? [["Other Expenses", otherExpMo * 12 * ge]] : []),
    ];
    const opEx = lines.reduce((s, x) => s + x[1], 0);
    const noi  = opIncome - opEx;

    let interestYr = 0, debtYr = 0;
    if (pmt > 0) {
      for (let m = 0; m < 12 && bal > 0; m++) {
        const i   = bal * rM;
        const pay = Math.min(pmt, bal + i);
        interestYr += i; debtYr += pay;
        bal = bal + i - pay;
        if (bal < 0.5) bal = 0;
      }
    }

    const cashFlow = noi - debtYr;
    cumCF += cashFlow;
    const depreciation = price * 0.8 / 27.5; // building at 80% of price, 27.5-yr straight line
    const taxable = noi - interestYr - depreciation;
    const taxDue  = taxable > 0 ? taxable * ((asm.taxRate ?? 24) / 100) : 0;
    const postTax = cashFlow - taxDue;
    const value   = price * Math.pow(1 + (asm.appreciation || 0) / 100, y);

    if (y < year) flows.push(cashFlow);
    else {
      const sellCosts    = value * (asm.sellingCosts || 0) / 100;
      const saleProceeds = value - sellCosts - bal;
      const totalProfit  = saleProceeds + cumCF - invested;
      flows.push(cashFlow + saleProceeds);
      const equity = value - bal;
      out = {vacPct, rentYr, otherYr, gross, vacancy, opIncome, lines, opEx, noi,
        interestYr, debtYr, cashFlow, cumCF, depreciation, taxable, taxDue, postTax,
        value, bal, equity, sellCosts, saleProceeds, invested, totalProfit,
        capPP: price > 0 ? noi / price * 100 : 0,
        capMV: value > 0 ? noi / value * 100 : 0,
        coc:   invested > 0 ? cashFlow / invested * 100 : 0,
        roe:   equity > 0 ? cashFlow / equity * 100 : 0,
        roi:   invested > 0 ? totalProfit / invested * 100 : 0,
        irr:   null,
        rentToValue: value > 0 ? (rentYr / 12) / value * 100 : 0,
        grm: gross > 0 ? value / gross : 0,
        equityMultiple: invested > 0 ? (cumCF + saleProceeds) / invested : 0,
        breakEven: gross > 0 ? (opEx + debtYr) / gross * 100 : 0,
      };
    }
  }
  if (out && invested > 0) {
    const npv = r => flows.reduce((s, f, i) => s + f / Math.pow(1 + r, i), 0);
    let lo = -0.9999, hi = 10;
    if (npv(lo) * npv(hi) < 0) {
      for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
      }
      out.irr = ((lo + hi) / 2) * 100;
    }
  }
  return out;
}

const PROJ_DEFAULTS = {appreciation:3, incomeGrowth:2, expenseGrowth:2, sellingCosts:6,
  maintenancePct:5, capexPct:5, taxRate:24};
const PROJ_YEARS    = [1, 2, 3, 5, 10, 15, 20, 30];

function ProjectionsSheet({deal, onPatchDeal, onClose, mobile}) {
  const [asm, setAsm]     = useState(() => ({...PROJ_DEFAULTS, ...(deal.projections || {})}));
  const [year, setYear]   = useState(1);
  const [showAsm, setShowAsm] = useState(false);
  const dirty = useRef(false);
  const setA  = (k, v) => { dirty.current = true; setAsm(x => ({...x, [k]: v})); };
  const close = () => {
    if (dirty.current && onPatchDeal) onPatchDeal(deal.id, {projections: asm});
    onClose();
  };
  const p = projectHold(deal, asm, year);
  const pct1 = n => (isNaN(n) || !isFinite(n) ? "0.0" : n.toFixed(1)) + "%";

  // Row: [label, value, color, strong, sub]
  const Sec = ({t, rows, note}) => (
    <div style={{marginTop:16}}>
      <div style={{fontSize:11, fontWeight:700, color:C.textSub, fontFamily:F,
        letterSpacing:".07em", textTransform:"uppercase", margin:"0 2px 7px"}}>{t}</div>
      <div style={{border:"1px solid "+C.border, borderRadius:C.r3, background:"#fff",
        boxShadow:C.sh1, padding:"6px 14px"}}>
        {rows.map((r, i) => r[0] === "hr"
          ? <div key={"hr"+i} style={{height:1, background:C.border, margin:"6px 0"}}/>
          : (
          <div key={String(r[0])+i} style={{display:"flex", justifyContent:"space-between",
            alignItems:"baseline", gap:10, padding:"7.5px 0"}}>
            <span style={{fontSize:12.5, color: r[3] ? C.text : C.textSub,
              fontWeight: r[3] ? 700 : 500, fontFamily:F}}>{r[0]}</span>
            <span style={{textAlign:"right", flexShrink:0}}>
              <span style={{display:"block", fontSize: r[3] ? 14.5 : 13.5, fontWeight: r[3] ? 800 : 600,
                color: r[2] || C.text, fontFamily:F, fontVariantNumeric:"tabular-nums",
                letterSpacing:"-0.01em"}}>{r[1]}</span>
              {r[4] && <span style={{display:"block", fontSize:10.5, color:C.textMuted,
                fontFamily:F, marginTop:1}}>{r[4]}</span>}
            </span>
          </div>
        ))}
      </div>
      {note && <div style={{fontSize:11.5, color:C.textMuted, fontFamily:F, lineHeight:1.5,
        margin:"7px 2px 0"}}>{note}</div>}
    </div>
  );

  return (
    <SheetShell title="Buy & Hold Projections" sub={`${deal.address}${deal.city ? `, ${deal.city}` : ""}`}
      onClose={close} mobile={mobile}>

      {/* Year picker — sticky so you can flip years from anywhere on the page */}
      <div style={{position:"sticky", top: mobile ? "calc(-16px - env(safe-area-inset-top, 0px))" : -22, zIndex:5,
        background:C.card, margin:"0 -6px", padding:"6px 6px 10px"}}>
        <div className="dh-chip-row" style={{display:"flex", gap:6, overflowX:"auto", padding:2}}>
          {PROJ_YEARS.map(y => {
            const active = year === y;
            return (
              <button key={y} onClick={()=>setYear(y)} style={{
                padding:"6px 13px", borderRadius:9999, whiteSpace:"nowrap", cursor:"pointer",
                border:"1px solid " + (active ? C.green : C.border),
                background: active ? C.green : "#fff",
                color: active ? "#fff" : C.textSub,
                fontSize:12, fontWeight:700, fontFamily:F, flexShrink:0,
                boxShadow: active ? "0 2px 6px -1px rgba(9,9,11,.25)" : "none",
                transition:"background .12s, color .12s, border-color .12s",
              }}>
                Year {y}
              </button>
            );
          })}
        </div>
      </div>

      {/* The year's verdict at a glance */}
      <div style={{
        display:"grid", gridTemplateColumns:"1fr 1fr", gap:1, marginTop:4,
        background:C.border, border:"1px solid "+C.border,
        borderRadius:C.r3, overflow:"hidden", boxShadow:C.sh1,
      }}>
        {[["Cash Flow / Yr", $(p.cashFlow), cfC(p.cashFlow)],
          ["Total Equity", $(p.equity), C.cashPos],
          ["Profit If Sold", $(p.totalProfit), cfC(p.totalProfit)],
          ["IRR", p.irr == null ? "—" : pct1(p.irr), C.text]].map(([l, v, color]) => (
          <div key={l} style={{background:"linear-gradient(180deg, #fff 0%, #fcfcfd 100%)",
            padding:"12px 8px 13px", textAlign:"center"}}>
            <div style={{display:"inline-flex", alignItems:"center", gap:5,
              fontSize:10.5, color:C.textSub, fontWeight:700, fontFamily:F,
              letterSpacing:".07em", textTransform:"uppercase"}}>
              <span style={{width:5, height:5, borderRadius:"50%", flexShrink:0, background:color}}/>
              {l}
            </div>
            <div style={{fontSize:19, fontWeight:500, color, fontFamily:F,
              fontVariantNumeric:"tabular-nums", letterSpacing:"-0.02em", marginTop:3}}>{v}</div>
          </div>
        ))}
      </div>

      {/* Assumptions — collapsed into one line until you want to tune them */}
      <div style={{marginTop:14, border:"1px solid "+C.border, borderRadius:C.r3,
        background:"#fff", boxShadow:C.sh1, overflow:"hidden"}}>
        <button onClick={()=>setShowAsm(s => !s)} style={{display:"flex", alignItems:"center",
          justifyContent:"space-between", gap:10, width:"100%", padding:"12px 14px",
          background:"none", border:"none", cursor:"pointer", textAlign:"left", fontFamily:F}}>
          <span style={{minWidth:0}}>
            <span style={{display:"block", fontSize:13, fontWeight:700, color:C.text, letterSpacing:"-0.005em"}}>
              Assumptions
            </span>
            <span style={{display:"block", fontSize:11.5, color:C.textSub, marginTop:2}}>
              {asm.appreciation}% appreciation · {asm.incomeGrowth}% income · {asm.expenseGrowth}% expenses · {asm.sellingCosts}% selling costs
            </span>
          </span>
          <span style={{color:C.textMuted, display:"inline-flex", flexShrink:0,
            transform: showAsm ? "rotate(180deg)" : "none", transition:"transform .15s"}}>
            <I.chevronDown size={16} stroke={2.2}/>
          </span>
        </button>
        {showAsm && (
          <div style={{padding:"2px 14px 2px", borderTop:"1px solid "+C.border}}>
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0 12px", paddingTop:12}}>
              <InputField label="Appreciation / Yr" val={asm.appreciation} set={v=>setA("appreciation", v)} suf="%" mobile={mobile}/>
              <InputField label="Income Increase / Yr" val={asm.incomeGrowth} set={v=>setA("incomeGrowth", v)} suf="%" mobile={mobile}/>
              <InputField label="Expense Increase / Yr" val={asm.expenseGrowth} set={v=>setA("expenseGrowth", v)} suf="%" mobile={mobile}/>
              <InputField label="Selling Costs" val={asm.sellingCosts} set={v=>setA("sellingCosts", v)} suf="%" mobile={mobile}/>
              <InputField label="Maintenance (% of Rent)" val={asm.maintenancePct} set={v=>setA("maintenancePct", v)} suf="%" mobile={mobile}/>
              <InputField label="CapEx (% of Rent)" val={asm.capexPct} set={v=>setA("capexPct", v)} suf="%" mobile={mobile}/>
              <InputField label="Income Tax Rate" val={asm.taxRate} set={v=>setA("taxRate", v)} suf="%" mobile={mobile}/>
            </div>
          </div>
        )}
      </div>

      <Sec t="Rental Income" rows={[
        ["Gross Rent", $(p.rentYr)],
        ...(p.otherYr > 0 ? [["Other Income", $(p.otherYr)]] : []),
        ["Vacancy", "-" + $(p.vacancy), C.red, false, `${p.vacPct}% of rent`],
        ["hr"],
        ["Operating Income", $(p.opIncome), C.text, true, `growing ${asm.incomeGrowth}%/yr`],
      ]}/>

      <Sec t="Operating Expenses" rows={[
        ...p.lines.map(([l, v]) => [l, $(v)]),
        ["hr"],
        ["Total Operating Expenses", $(p.opEx), C.red, true, `growing ${asm.expenseGrowth}%/yr`],
      ]}/>

      <Sec t="Cash Flow" rows={[
        ["Operating Income", $(p.opIncome)],
        ["Operating Expenses", "-" + $(p.opEx), C.red, false,
          p.gross > 0 ? `${(p.opEx / p.gross * 100).toFixed(1)}% of income` : null],
        ["hr"],
        ["Net Operating Income", $(p.noi), C.text, true],
        ...(p.debtYr > 0 ? [["Debt Service", "-" + $(p.debtYr), C.red]] : []),
        ["Cash Flow", $(p.cashFlow), cfC(p.cashFlow), true],
        ["Post-Tax Cash Flow", $(p.postTax), cfC(p.postTax), true, `after ${asm.taxRate}% income tax`],
      ]}/>

      <Sec t="Tax Benefits & Deductions" rows={[
        ["Operating Expenses", $(p.opEx)],
        ...(p.interestYr > 0 ? [["Mortgage Interest", $(p.interestYr)]] : []),
        ["Depreciation", $(p.depreciation), null, false, "27.5-yr straight line, building at 80%"],
        ["hr"],
        ["Total Deductions", $(p.totalDeductions ?? (p.opEx + p.interestYr + p.depreciation)), C.text, true],
      ]} note={p.taxable < 0
        ? `Paper loss of ${$(Math.abs(p.taxable))} this year — real cash flow the IRS sees as a loss. Talk to your CPA.`
        : `Taxable income after deductions: ${$(p.taxable)} at ${asm.taxRate ?? 24}%.`}/>

      <Sec t="Equity Accumulation" rows={[
        ["Property Value", $(p.value), null, false, `${asm.appreciation}% appreciation`],
        ...(p.bal > 0 ? [["Loan Balance", "-" + $(p.bal), C.red]] : []),
        ["hr"],
        ["Total Equity", $(p.equity), C.cashPos, true],
      ]}/>

      <Sec t="Sale Analysis" rows={[
        ["Equity", $(p.equity)],
        ["Selling Costs", "-" + $(p.sellCosts), C.red, false, `${asm.sellingCosts}% of sale price`],
        ["hr"],
        ["Sale Proceeds", $(p.saleProceeds), C.text, true],
        ["Cumulative Cash Flow", "+" + $(p.cumCF), cfC(p.cumCF)],
        ["Total Cash Invested", "-" + $(p.invested), C.red],
        ["hr"],
        ["Total Profit", $(p.totalProfit), cfC(p.totalProfit), true, `if sold in year ${year}`],
      ]}/>

      <Sec t="Investment Returns" rows={[
        ["Cap Rate (Purchase Price)", pct1(p.capPP), null, false, "NOI ÷ what you paid"],
        ["Cap Rate (Market Value)", pct1(p.capMV), null, false, "NOI ÷ today's value"],
        ["Cash on Cash Return", pct1(p.coc), null, false, "cash flow ÷ cash invested"],
        ["Return on Equity", pct1(p.roe), null, false, "cash flow ÷ total equity"],
        ["Return on Investment", pct1(p.roi), null, false, "total profit ÷ cash invested"],
        ["Internal Rate of Return", p.irr == null ? "—" : pct1(p.irr), C.text, true, `annualized, sold in year ${year}`],
      ]}/>

      <Sec t="Financial Ratios" rows={[
        ["Rent to Value", pct1(p.rentToValue), null, false, "monthly rent ÷ property value"],
        ["Gross Rent Multiplier", (p.grm || 0).toFixed(2), null, false, "value ÷ gross annual rent"],
        ["Equity Multiple", (p.equityMultiple || 0).toFixed(2), null, false, "(cash flow + proceeds) ÷ invested"],
        ["Break Even Ratio", pct1(p.breakEven), null, false, "(expenses + debt) ÷ income"],
      ]} note="Projections run on the numbers saved with this deal — re-save from the Deal Calculator after edits to refresh them."/>
    </SheetShell>
  );
}

// -- Deal View -------------------------------------------------------------------
// The home of a saved deal: hero gallery, the saved verdict numbers up top,
// then a grouped hub of everything else. Opens from any saved-deal card.
function DealViewPage({deal, isPro, onClose, onAnalyze, onRemove, onUpgrade, apiLookup, rcAuth, onUploadPhotos, onPatchDeal, mobile}) {
  const {strat, heroNumber, secondaryMetrics} =
    dealHeroMetrics(deal, deal.scenario || null, deal.financing || null);
  const [idx, setIdx]     = useState(0);
  const [sheet, setSheet] = useState(null); // null | "comps" | "owner" | "records"
  const [shared, setShared] = useState(false);
  const fileRef = useRef(null);
  const [upBusy, setUpBusy] = useState(false);
  const [upNote, setUpNote] = useState("");

  // One provided shot — the straight-on Street View of the front — plus the
  // user's own uploads. Feed deals keep their real listing photos when the
  // source provided them.
  const uploads  = Array.isArray(deal.userPhotos) ? deal.userPhotos : [];
  const provided = Array.isArray(deal.photos) && deal.photos.length
    ? deal.photos
    : (deal.lat && deal.lng ? [svUrl(deal.lat, deal.lng, 900, 560)]
      : (deal.photo ? [deal.photo] : []));
  // The user's first upload leads — it's the deal's face everywhere. With no
  // uploads, the straight-on Street View front shot takes over.
  const photos  = [...uploads, ...provided];
  const visible = photos;

  useEffect(() => {
    lockBodyScroll();
    const handler = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => {
      unlockBodyScroll();
      window.removeEventListener("keydown", handler);
    };
  }, [onClose]);

  const mapsHref = deal.lat && deal.lng
    ? `https://maps.google.com/?q=${deal.lat},${deal.lng}`
    : `https://maps.google.com/?q=${encodeURIComponent([deal.address, deal.city, deal.state].filter(Boolean).join(", "))}`;
  const zillowHref = `https://www.zillow.com/homes/${encodeURIComponent([deal.address, deal.city, deal.state, deal.zip].filter(Boolean).join(" "))}_rb/`;

  const finLabel = deal.financing === "owned" ? "Owned"
    : deal.financing === "cash" ? "Cash"
    : deal.financing === "finance" ? "Finance" : null;

  useEffect(() => { if (idx > 0 && idx >= photos.length) setIdx(0); }, [photos.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickFiles = () => {
    setUpNote("");
    if (!isPro && uploads.length >= 5) {
      setUpNote("Free plan holds 5 of your own photos per deal — Pro is unlimited.");
      return;
    }
    if (fileRef.current) fileRef.current.click();
  };
  const onFiles = async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length || !onUploadPhotos) return;
    let take = files;
    if (!isPro) {
      const room = Math.max(5 - uploads.length, 0);
      if (files.length > room) {
        take = files.slice(0, room);
        setUpNote(`Free plan holds 5 photos per deal — added the first ${room}.`);
      }
    }
    if (!take.length) return;
    setUpBusy(true);
    try {
      const urls = await onUploadPhotos(deal, take);
      if (onPatchDeal) onPatchDeal(deal.id, {userPhotos: [...uploads, ...urls]});
    } catch (err) {
      setUpNote((err && err.message) || "Upload failed — try again.");
    }
    setUpBusy(false);
  };
  const removePhoto = (u) => {
    if (onPatchDeal) onPatchDeal(deal.id, {userPhotos: uploads.filter(x => x !== u)});
    setIdx(0);
  };

  const share = async () => {
    const text = `${[deal.address, deal.city, deal.state].filter(Boolean).join(", ")} — ${$(deal.price)} · ${heroNumber.label}: ${heroNumber.value} · analyzed on DealHive (dealhive.io)`;
    try {
      if (navigator.share) { await navigator.share({title: deal.address, text}); }
      else { await navigator.clipboard.writeText(text); setShared(true); setTimeout(()=>setShared(false), 2200); }
    } catch { /* user cancelled the share sheet */ }
  };

  const outerStyle = mobile
    ? {position:"fixed", inset:0, background:C.bg, zIndex:500}
    : {position:"fixed", inset:0, background:"rgba(9,9,11,.55)", zIndex:500,
       display:"flex", alignItems:"center", justifyContent:"center", padding:20,
       backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)"};
  const innerStyle = mobile
    ? {background:C.bg, width:"100%", height:"100%",
       overflowY:"auto", overscrollBehavior:"contain", WebkitOverflowScrolling:"touch"}
    : {background:C.bg, borderRadius:C.r5, width:"100%", maxWidth:640,
       maxHeight:"93dvh", overflowY:"auto", overscrollBehavior:"contain", boxShadow:C.sh4, border:"1px solid "+C.border};

  const pill = (label, bg, color, border, dot) => (
    <span key={label} style={{display:"inline-flex", alignItems:"center", gap:5,
      background:bg, color, border:"1px solid "+border,
      padding:"4px 11px", borderRadius:9999, fontSize:11.5, fontWeight:700, fontFamily:F,
      letterSpacing:"-0.005em"}}>
      {dot && <span style={{width:6, height:6, borderRadius:"50%", background:dot}}/>}
      {label}
    </span>
  );

  const Row = ({Ic, label, pro, onClick, last}) => (
    <button onClick={onClick} style={{display:"flex", alignItems:"center", gap:12, width:"100%",
      padding:"14px", background:"#fff", border:"none", cursor:"pointer", textAlign:"left",
      borderBottom: last ? "none" : "1px solid "+C.border, fontFamily:F}}>
      <span style={{width:32, height:32, borderRadius:9, flexShrink:0, background:C.greenSubtle,
        border:"1px solid "+C.greenBorder, color:C.greenDark, display:"inline-flex",
        alignItems:"center", justifyContent:"center"}}><Ic size={15} stroke={2}/></span>
      <span style={{flex:1, minWidth:0, display:"flex", alignItems:"center", gap:8,
        fontSize:14.5, fontWeight:650, color:C.text, letterSpacing:"-0.01em"}}>
        {label}
        {pro && !isPro && (
          <span style={{fontSize:9.5, fontWeight:800, color:C.greenDark, background:C.greenSubtle,
            border:"1px solid "+C.greenBorder, borderRadius:9999, padding:"1.5px 7px",
            letterSpacing:".05em"}}>PRO</span>
        )}
      </span>
      <span style={{color:C.textMuted, flexShrink:0, display:"inline-flex"}}>
        <I.chevronRight size={15} stroke={2.2}/>
      </span>
    </button>
  );
  const Group = ({title, children}) => (
    <div style={{marginTop:16}}>
      <div style={{fontSize:11, fontWeight:700, color:C.textSub, fontFamily:F, letterSpacing:".07em",
        textTransform:"uppercase", margin:"0 2px 7px"}}>{title}</div>
      <div style={{border:"1px solid "+C.border, borderRadius:C.r4, overflow:"hidden",
        boxShadow:C.sh1, background:"#fff"}}>
        {children}
      </div>
    </div>
  );

  return (
    <div style={outerStyle} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={innerStyle}>
        {/* Gallery */}
        <div style={{position:"relative", background:C.bgSubtle}}>
          <div style={{height: mobile ? 235 : 300, overflow:"hidden"}}>
            <SafeImg src={visible[idx] || visible[0]} fallback={imgPlaceholder(36)}
              style={{width:"100%", height:"100%", objectFit:"cover", display:"block"}}/>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{position:"absolute", top:"calc(14px + env(safe-area-inset-top, 0px))", right:14, width:38, height:38, borderRadius:"50%",
              background:"rgba(255,255,255,.94)", border:"none", cursor:"pointer", color:C.text,
              display:"flex", alignItems:"center", justifyContent:"center", boxShadow:C.sh3}}>
            <I.x size={17}/>
          </button>
          {visible.length > 1 && (
            <div style={{position:"absolute", bottom:12, right:12, background:"rgba(9,9,11,.65)",
              color:"#fff", padding:"3px 10px", borderRadius:9999, fontSize:11.5, fontWeight:700,
              fontFamily:F, fontVariantNumeric:"tabular-nums"}}>
              {idx+1} / {visible.length}
            </div>
          )}
        </div>
        {visible.length > 1 && (
          <div style={{display:"flex", gap:8, padding:"12px 16px 4px", overflowX:"auto"}}>
            {visible.map((src, i) => (
              <button key={i} onClick={()=>setIdx(i)}
                style={{width:64, height:46, borderRadius:8, overflow:"hidden", padding:0, flexShrink:0,
                  border: i === idx ? "2px solid "+C.green : "1px solid "+C.border,
                  cursor:"pointer", background:C.bgSubtle}}>
                <SafeImg src={src.replace("size=900x560","size=200x140")} fallback={imgPlaceholder(14)}
                  style={{width:"100%", height:"100%", objectFit:"cover", display:"block"}}/>
              </button>
            ))}
          </div>
        )}

        {/* Address + pills */}
        <div style={{padding:"16px 20px 0", textAlign:"center"}}>
          <div style={{display:"inline-flex", gap:7, flexWrap:"wrap", justifyContent:"center", marginBottom:9}}>
            {pill($(deal.price), C.sidebar, "#fff", C.sidebar, null)}
            {pill(strat.label, strat.bg, strat.color, strat.border, strat.dot)}
            {finLabel && pill(finLabel, "#fff", C.text, C.border, null)}
          </div>
          <div style={{fontSize:20, fontWeight:800, color:C.text, fontFamily:F, letterSpacing:"-0.02em", lineHeight:1.25}}>
            {deal.address}
          </div>
          {(deal.city || deal.state) && (
            <div style={{fontSize:14, color:C.textSub, fontFamily:F, fontWeight:600, marginTop:2}}>
              {[deal.city, [deal.state, deal.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")}
            </div>
          )}
        </div>

        {/* Saved verdict — same numbers as the card, always visible */}
        <div style={{padding:"14px 16px 0"}}>
          <div style={{
            display:"grid", gridTemplateColumns:"1fr 1fr", gap:1,
            background:C.border, border:"1px solid "+C.border,
            borderRadius:C.r3, overflow:"hidden", boxShadow:C.sh1,
          }}>
            {[[heroNumber.label, heroNumber.value, heroNumber.color, false, true],
              ...secondaryMetrics.map(([l, v, vColor, keepCase]) => [l, v, vColor, keepCase, false])]
              .map(([l, v, vColor, keepCase, isHero]) => (
              <div key={l} style={{
                background:"linear-gradient(180deg, #fff 0%, #fcfcfd 100%)",
                padding:"13px 10px 15px", textAlign:"center",
              }}>
                <div style={{display:"inline-flex", alignItems:"center", gap:5,
                  fontSize:10.5, color:C.textSub, fontWeight:700, fontFamily:F,
                  letterSpacing:".07em", textTransform: keepCase ? "none" : "uppercase"}}>
                  <span style={{width:5, height:5, borderRadius:"50%", flexShrink:0,
                    background: vColor || (isHero ? heroNumber.color : C.borderHover)}}/>
                  {l}
                </div>
                <div style={{fontSize: isHero ? 21 : 18, fontWeight:500,
                  color: vColor || (isHero ? heroNumber.color : C.text), fontFamily:F,
                  fontVariantNumeric:"tabular-nums", letterSpacing:"-0.02em", marginTop:4}}>
                  {v}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Facts */}
        {(deal.beds > 0 || deal.baths > 0 || deal.sqft > 0 || deal.yearBuilt > 0) && (
          <div style={{padding:"14px 16px 0"}}>
            <div style={{display:"grid", gridTemplateColumns: mobile ? "repeat(3, 1fr)" : "repeat(6, 1fr)",
              gap:1, background:C.border, border:"1px solid "+C.border,
              borderRadius:C.r4, overflow:"hidden", boxShadow:C.sh1}}>
              {[
                ["Beds",  deal.beds || "—",  I.bed],
                ["Baths", deal.baths || "—", I.bath],
                ["Sqft",  deal.sqft ? deal.sqft.toLocaleString() : "—", I.ruler],
                ["Lot",   deal.lotSize ? deal.lotSize.toLocaleString() : "—", I.parcel],
                ["Year",  deal.yearBuilt || "—", I.calendar],
                ["Type",  deal.type || "—", I.home],
              ].map(([l, v, Ic]) => (
                <div key={l} style={{background:"linear-gradient(180deg, #fff 0%, #fbfbfc 100%)",
                  padding:"11px 6px", textAlign:"center"}}>
                  <div style={{width:28, height:28, borderRadius:8, margin:"0 auto 5px",
                    background:C.greenSubtle, border:"1px solid "+C.greenBorder, color:C.greenDark,
                    display:"flex", alignItems:"center", justifyContent:"center"}}>
                    <Ic size={13} stroke={2}/>
                  </div>
                  <div style={{fontSize:13.5, fontWeight:700, color:C.text, fontFamily:F,
                    fontVariantNumeric:"tabular-nums",
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{v}</div>
                  <div style={{fontSize:9.5, color:C.textSub, fontFamily:F, fontWeight:700,
                    letterSpacing:".06em", textTransform:"uppercase", marginTop:1}}>{l}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Photos — the front shot is ours; the rest are the user's own */}
        <div style={{padding:"16px 16px 0"}}>
          <div style={{fontSize:11, fontWeight:700, color:C.textSub, fontFamily:F,
            letterSpacing:".07em", textTransform:"uppercase", margin:"0 2px 7px"}}>
            Photos
          </div>
          <div style={{border:"1px solid "+C.border, borderRadius:C.r4, background:"#fff",
            boxShadow:C.sh1, padding:12}}>
            <div style={{display:"flex", gap:10, overflowX:"auto", padding:"6px 2px 2px"}}>
              {uploads.map(u => (
                <div key={u} style={{position:"relative", flexShrink:0}}>
                  <SafeImg src={u} fallback={imgPlaceholder(14)}
                    style={{width:86, height:64, borderRadius:8, objectFit:"cover", display:"block",
                      border:"1px solid "+C.border}}/>
                  <button onClick={()=>removePhoto(u)} aria-label="Remove photo"
                    style={{position:"absolute", top:-7, right:-7, width:21, height:21, borderRadius:"50%",
                      background:C.text, color:"#fff", border:"2px solid #fff", cursor:"pointer",
                      display:"flex", alignItems:"center", justifyContent:"center", padding:0,
                      boxShadow:C.sh2}}>
                    <I.x size={10} stroke={2.6}/>
                  </button>
                </div>
              ))}
              <button onClick={pickFiles} disabled={upBusy}
                style={{width:86, height:64, borderRadius:8, flexShrink:0, cursor:"pointer",
                  border:"1.5px dashed "+C.greenBorder, background:C.greenSubtle, color:C.greenDark,
                  display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
                  gap:3, fontSize:10.5, fontWeight:700, fontFamily:F}}>
                {upBusy
                  ? <span className="dh-pulse">Uploading…</span>
                  : <><I.plus size={15} stroke={2.4}/> Add Photos</>}
              </button>
            </div>
            <div style={{fontSize:11.5, color: upNote ? C.amberDark : C.textSub, fontFamily:F,
              marginTop:9, lineHeight:1.5}}>
              {upNote || (isPro
                ? "Add your own photos — walkthroughs, rehab progress, anything."
                : `Your own photos of this property — ${Math.max(5 - uploads.length, 0)} of 5 free slots left.`)}
            </div>
            {!isPro && uploads.length >= 5 && onUpgrade && (
              <button onClick={onUpgrade} {...btnStyle("secondary","sm", {marginTop:9})}>
                <I.star size={11}/> Unlimited photos with Pro
              </button>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" multiple
            style={{display:"none"}} onChange={onFiles}/>
        </div>

        {/* Hub */}
        <div style={{padding:"0 16px"}}>
          <Group title="Analysis">
            <Row Ic={I.chart} label="Deal Calculator"
              onClick={()=>{ onClose(); onAnalyze(deal); }}/>
            <Row Ic={I.trendingUp} label="Buy & Hold Projections"
              onClick={()=>setSheet("proj")} last/>
          </Group>
          <Group title="Research">
            <Row Ic={I.tag} label="Sales Comps & ARV"
              onClick={()=>setSheet("sales")}/>
            <Row Ic={I.dollar} label="Rental Comps & Estimate"
              onClick={()=>setSheet("comps")}/>
            <Row Ic={I.user} label="Owner Lookup" pro
              onClick={()=>setSheet("owner")}/>
            <Row Ic={I.receipt} label="Property Records"
              onClick={()=>setSheet("records")} last/>
          </Group>
          <Group title="Tools">
            <Row Ic={I.externalLink} label={shared ? "Copied to Clipboard!" : "Share Deal"}
              onClick={share} last/>
          </Group>
        </div>

        {/* Map + external links */}
        {deal.lat && deal.lng && (
          <div style={{padding:"16px 16px 0"}}>
            <MiniMap lat={deal.lat} lng={deal.lng}/>
          </div>
        )}
        <div style={{padding:"12px 16px 0", display:"flex", gap:10}}>
          <a href={mapsHref} target="_blank" rel="noreferrer" style={{flex:1, textDecoration:"none"}}>
            <span {...btnStyle("secondary","md", {width:"100%", justifyContent:"center"})}>
              <I.pin size={13}/> Open in Maps
            </span>
          </a>
          <a href={zillowHref} target="_blank" rel="noreferrer" style={{flex:1, textDecoration:"none"}}>
            <span {...btnStyle("secondary","md", {width:"100%", justifyContent:"center"})}>
              <I.externalLink size={13}/> View on Zillow
            </span>
          </a>
        </div>

        {/* Remove */}
        <div style={{padding:"14px 16px 24px"}}>
          <button onClick={()=>onRemove(deal)}
            {...btnStyle("danger","md", {width:"100%", justifyContent:"center"})}>
            <I.trash size={13}/> Remove from Saved Deals
          </button>
        </div>
      </div>

      {sheet === "comps" && (
        <RentCompsSheet p={deal} apiLookup={apiLookup} rcAuth={rcAuth}
          tier={isPro ? "pro" : "free"} onUpgrade={onUpgrade}
          onClose={()=>setSheet(null)} mobile={mobile} />
      )}
      {sheet === "owner" && (
        <OwnerLookupSheet deal={deal} isPro={isPro} apiLookup={apiLookup} rcAuth={rcAuth}
          onUpgrade={onUpgrade} onClose={()=>setSheet(null)} mobile={mobile} />
      )}
      {sheet === "records" && (
        <RecordsSheet deal={deal} apiLookup={apiLookup} rcAuth={rcAuth}
          onClose={()=>setSheet(null)} mobile={mobile} />
      )}
      {sheet === "sales" && (
        <SalesCompsSheet deal={deal} isPro={isPro} apiLookup={apiLookup} rcAuth={rcAuth}
          onUpgrade={onUpgrade} onClose={()=>setSheet(null)} mobile={mobile} />
      )}
      {sheet === "proj" && (
        <ProjectionsSheet deal={deal} onPatchDeal={onPatchDeal}
          onClose={()=>setSheet(null)} mobile={mobile} />
      )}
    </div>
  );
}

function SavedDealsDashboard({savedDeals = [], tier, onUpgrade, onAnalyze, onRemove, onBrowse, onBrowseStrategy, onAnalyzeNew, apiLookup, rcAuth, onUploadPhotos, onPatchDeal, openDealId, onConsumeOpenDeal, mobile}) {
  const isPro  = tier === "pro";
  const isWide = useIsWide();
  const [selectedId, setSelectedId] = useState(openDealId || null);
  // Coming back from the analyzer reopens the deal that was being viewed;
  // consume the hand-off so later visits start clean.
  useEffect(() => { if (openDealId && onConsumeOpenDeal) onConsumeOpenDeal(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [strat, setStrat] = useState("all"); // all | buyhold | flip | wholesale
  const [confirmRemove, setConfirmRemove] = useState(null); // deal pending delete

  useEffect(() => { window.scrollTo(0, 0); }, []);

  if (savedDeals.length === 0) {
    return (
      <div style={{padding: mobile ? "20px 16px 100px" : "32px 32px"}}>
        <PageHeader title="My Saved Deals"
          subtitle="Track deals you're interested in. Save any deal from the Deals page and it'll land here."/>
        <StrategyCards active="all" counts={{}} mobile={mobile}
          onSelect={st => st !== "all" && onBrowseStrategy(st)}/>
        <EmptyState
          icon={<I.search size={22}/>}
          title="No saved deals yet"
          body="Analyze any address and save it — your deals will live here, organized by strategy."
          action={
            <button onClick={onAnalyzeNew} {...btnStyle("primary","md")}>
              <I.search size={13}/> Analyze a Deal
            </button>
          }
        />
      </div>
    );
  }

  // Newest-saved first, pre-classified once so tab counts and filtering agree.
  const ordered = [...savedDeals].sort((a, b) =>
    (b.savedAt || "").localeCompare(a.savedAt || "")
  ).map(d => ({d, c: classifyDeal(d)}));

  // The scenario chosen at save time wins; legacy saves (no scenario field)
  // fall back to the automatic classification.
  const inScenario = ({d, c}, key) =>
    d.scenario ? d.scenario === key
    : key === "wholesale" ? isWholesaleDeal(d)
    : c.tags.includes(key);
  const matches = pair => strat === "all" ? true : inScenario(pair, strat);
  const shown  = ordered.filter(matches);
  const counts = {
    buyhold:   ordered.filter(pair => inScenario(pair, "buyhold")).length,
    brrrr:     ordered.filter(pair => inScenario(pair, "brrrr")).length,
    flip:      ordered.filter(pair => inScenario(pair, "flip")).length,
    wholesale: ordered.filter(pair => inScenario(pair, "wholesale")).length,
  };

  return (
    <div style={{padding: mobile ? "20px 16px 100px" : "32px 32px"}}>
      <StrategyCards active={strat} counts={counts} onSelect={setStrat} mobile={mobile}/>

      {shown.length === 0 ? (
        <EmptyState
          icon={<I.star size={22}/>}
          title={strat === "wholesale" ? "No saved wholesale deals"
               : strat === "flip"      ? "No saved fix and flips"
               : strat === "brrrr"     ? "No saved BRRRR deals"
               : "No saved rentals"}
          body="Nothing in your watchlist matches this scenario yet. Browse the feed and save a few."
          action={
            <button onClick={()=>onBrowseStrategy(strat)} {...btnStyle("primary","md")}>
              <I.star size={13}/> Browse {strat === "wholesale" ? "wholesale deals" : strat === "flip" ? "fix & flips" : strat === "brrrr" ? "BRRRR deals" : "rentals"}
            </button>
          }
        />
      ) : (
      <div style={{display:"grid",
        gridTemplateColumns: mobile ? "1fr" : isWide ? "repeat(3, 1fr)" : "repeat(2, 1fr)",
        gap:16}}>
        {shown.map(({d}) => (
          <DealCard key={d.id} deal={d} isPro={isPro}
            onAnalyze={() => setSelectedId(d.id)}
            onSave={() => setConfirmRemove(d)}
            saveLabel="Remove"
            saveIcon={<I.trash size={13}/>}
            saveAriaLabel="Remove from saved deals"
            analyzeLabel="View Deal"
            hideSource showAddress
            savedScenario={d.scenario || null}
            savedFinancing={d.financing || null}
            onUpgrade={onUpgrade}
            onOpen={() => setSelectedId(d.id)}
            mobile={mobile} />
        ))}
      </div>
      )}

      {selectedId && (() => {
        const d = ordered.map(x => x.d).find(x => x.id === selectedId);
        if (!d) return null;
        return (
          <DealViewPage
            deal={d} isPro={isPro}
            onClose={() => setSelectedId(null)}
            onAnalyze={onAnalyze}
            onRemove={dd => { setSelectedId(null); setConfirmRemove(dd); }}
            onUpgrade={onUpgrade}
            apiLookup={apiLookup} rcAuth={rcAuth}
            onUploadPhotos={onUploadPhotos} onPatchDeal={onPatchDeal}
            mobile={mobile} />
        );
      })()}

      {confirmRemove && (
        <div onClick={e => e.target === e.currentTarget && setConfirmRemove(null)}
          style={{position:"fixed", inset:0, zIndex:650, background:"rgba(9,9,11,.55)",
            backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)",
            display:"flex", alignItems:"center", justifyContent:"center", padding:24}}>
          <div style={{background:C.card, borderRadius:C.r5, width:"100%", maxWidth:380,
            padding:"26px 24px", boxShadow:C.sh4, border:"1px solid "+C.border, textAlign:"center"}}>
            <div style={{width:52, height:52, borderRadius:"50%", margin:"0 auto 14px",
              background:C.redSubtle, border:"1px solid "+C.redBorder, color:C.redDark,
              display:"flex", alignItems:"center", justifyContent:"center"}}>
              <I.trash size={22}/>
            </div>
            <div style={{fontSize:18, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.015em"}}>
              Remove this deal?
            </div>
            <div style={{fontSize:13.5, color:C.textSub, fontFamily:F, marginTop:6, lineHeight:1.5,
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
              {confirmRemove.address}
            </div>
            <div style={{fontSize:12.5, color:C.textMuted, fontFamily:F, marginTop:2}}>
              This can't be undone.
            </div>
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:20}}>
              <button onClick={()=>setConfirmRemove(null)} {...btnStyle("secondary","lg", {justifyContent:"center"})}>
                Cancel
              </button>
              <button onClick={()=>{ onRemove(confirmRemove); setConfirmRemove(null); }}
                style={{padding:"13px 18px", borderRadius:10, border:"1px solid "+C.red,
                  background:C.red, color:"#fff", fontWeight:700, fontSize:14, fontFamily:F,
                  cursor:"pointer", display:"inline-flex", alignItems:"center", justifyContent:"center", gap:7}}>
                <I.trash size={14}/> Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// What free members see in place of the feed: a blurred sample-card preview
// under a lock panel. The real gate is server-side — database rules refuse
// the /deals read for non-Pro accounts — so dev tools can't peel this back.
function DealsLockedPreview({mobile, isWide, onUpgrade}) {
  return (
    <div style={{padding: mobile ? "20px 16px 100px" : "32px 32px"}}>
      <PageHeader title="Deals" subtitle="Fresh investment deals, sourced nightly across 31 metros"/>
      <div style={{position:"relative", borderRadius:C.r4, overflow:"hidden"}}>
        <div aria-hidden="true" style={{
          display:"grid", gap:16, filter:"blur(6px)", opacity:.8,
          pointerEvents:"none", userSelect:"none",
          gridTemplateColumns: mobile ? "1fr" : isWide ? "repeat(3, 1fr)" : "repeat(2, 1fr)",
        }}>
          {SAMPLE_DEALS.slice(0, mobile ? 3 : 6).map(d => (
            <DealCard key={d.id} deal={d} isPro={false} hideSource
              onAnalyze={()=>{}} onSave={()=>{}} onUpgrade={()=>{}} mobile={mobile} />
          ))}
        </div>
        <div style={{position:"absolute", inset:0, display:"flex", flexDirection:"column",
          alignItems:"center", justifyContent:"center", gap:12, padding:"0 24px", textAlign:"center",
          background:"linear-gradient(180deg, rgba(250,250,250,.35) 0%, rgba(250,250,250,.95) 80%)"}}>
          <div style={{width:52, height:52, borderRadius:"50%",
            background:C.greenSubtle, border:"1px solid "+C.greenBorder, color:C.greenDark,
            display:"flex", alignItems:"center", justifyContent:"center", boxShadow:C.sh2}}>
            <I.lock size={22} stroke={2.2}/>
          </div>
          <div style={{fontSize:20, fontWeight:800, color:C.text, fontFamily:F, letterSpacing:"-0.02em"}}>
            The Deal Feed is a Pro feature
          </div>
          <div style={{fontSize:13.5, color:C.textSub, fontFamily:F, lineHeight:1.6, maxWidth:400}}>
            Wholesale, MLS, and off-market deals land here every night — exact
            addresses, seller contacts, and the numbers already run.
          </div>
          <button onClick={onUpgrade} {...btnStyle("primary","lg", {marginTop:2})}>
            <I.star size={14}/> Unlock the Deal Feed — $29.99/mo
          </button>
          <div style={{fontSize:12, color:C.textMuted, fontFamily:F}}>Cancel anytime.</div>
        </div>
      </div>
    </div>
  );
}

function DealsPage({tier, onUpgrade, onAnalyzeDeal, onSaveDeal, mobile, token, locked = false,
                    strategy: strategyProp, onStrategyChange}) {
  const [market, setMarket]     = useState("all");
  // Strategy can be driven from outside (dashboard shortcut cards set it
  // before navigating here); otherwise it's plain local state.
  const [localStrategy, setLocalStrategy] = useState("all"); // all | buyhold | flip | wholesale
  const strategy    = strategyProp ?? localStrategy;
  const setStrategy = onStrategyChange ?? setLocalStrategy;
  const [maxPrice, setMaxPrice] = useState(0);
  // Live feed from /deals (populated by the nightly Cloud Function). When the
  // fetch hasn't returned yet (or hasn't been seeded), we fall back to
  // SAMPLE_DEALS so the page is never empty during dev / pre-Phase-1 deploys.
  const [feed, setFeed]         = useState(null);   // {items, updatedAt} | null
  const [feedErr, setFeedErr]   = useState(false);
  // Which deal is open in the detail modal (or null).
  const [selectedId, setSelectedId] = useState(null);
  const isWide = useIsWide();
  const isPro  = tier === "pro";

  useEffect(() => { window.scrollTo(0, 0); }, []);

  // Fetch the curated feed from Firebase. DB rules require auth, so we pass
  // the user's ID token. If the read fails or returns nothing, we show the
  // sample deals (and a "feed not seeded yet" indicator).
  useEffect(() => {
    if (locked) return; // Pro-only: the server would refuse the read anyway
    let alive = true;
    (async () => {
      try {
        const url = `${FB_DB_URL}/deals.json` + (token ? `?auth=${token}` : "");
        const r = await fetch(url);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const data = await r.json();
        if (alive) setFeed(data || {items: {}, updatedAt: 0});
      } catch {
        if (alive) { setFeedErr(true); setFeed({items: {}, updatedAt: 0}); }
      }
    })();
    return () => { alive = false; };
  }, [token]);

  // Use the live feed when it has items, otherwise sample fallback.
  const liveItems   = feed && feed.items ? Object.values(feed.items) : [];
  const sourceDeals = liveItems.length > 0 ? liveItems : SAMPLE_DEALS;
  const usingLive   = liveItems.length > 0;

  // Filter through classification + user filters.
  const classified = sourceDeals
    .filter(isResidential)
    .map(d => ({d, c: classifyDeal(d)}))
    .filter(({c}) => c.tags.length > 0);

  // Build the market dropdown options from the actual data — InvestorLift
  // goes nationwide, so hardcoding 6 markets would hide most of the feed.
  // Group by state, prefer the curated label if we have one.
  const marketCountsByState = new Map();
  classified.forEach(({d}) => {
    const key = (d.state || "").toUpperCase();
    if (!key) return;
    marketCountsByState.set(key, (marketCountsByState.get(key) || 0) + 1);
  });
  // Just state codes — no city, no count. Sorted alphabetically so the user
  // sees a predictable A→Z list rather than the volume-rank shuffle.
  const availableMarkets = [...marketCountsByState.entries()]
    .map(([state, count]) => ({id: state, label: state, count}))
    .sort((a, b) => a.label.localeCompare(b.label));

  const filtered = classified.filter(({d, c}) => {
    if (market !== "all" && (d.state || "").toUpperCase() !== market) return false;
    if (maxPrice > 0 && d.price > maxPrice) return false;
    if (strategy === "buyhold"   && !c.tags.includes("buyhold")) return false;
    if (strategy === "brrrr"     && !c.tags.includes("brrrr"))   return false;
    if (strategy === "flip"      && !c.tags.includes("flip"))    return false;
    if (strategy === "wholesale" && !isWholesaleDeal(d))         return false;
    return true;
  });

  // Rank by best score, so the "loudest" deals lead.
  filtered.sort((a, b) => {
    const aBest = Math.max(a.c.buyHoldScore, a.c.flipScore);
    const bBest = Math.max(b.c.buyHoldScore, b.c.flipScore);
    return bBest - aBest;
  });

  const visible = isPro ? filtered : filtered.slice(0, FREE_PREVIEW_COUNT);
  const lockedCount = filtered.length - visible.length;

  if (locked) return <DealsLockedPreview mobile={mobile} isWide={isWide} onUpgrade={onUpgrade} />;

  // KPI counts for the header chip.
  const buyHoldCount = filtered.filter(({c}) => c.tags.includes("buyhold")).length;
  const flipCount    = filtered.filter(({c}) => c.tags.includes("flip")).length;

  return (
    <div style={{padding: mobile ? "20px 16px 100px" : "32px 32px"}}>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start",
        gap:16, flexWrap:"wrap", marginBottom:20}}>
        <div style={{minWidth:0}}>
          <div style={{display:"flex", alignItems:"center", gap:8, flexWrap:"wrap"}}>
            <h1 style={{margin:0, fontSize:24, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.02em"}}>
              Deals
            </h1>
            {usingLive ? (
              <span style={{
                display:"inline-flex", alignItems:"center", gap:4,
                background:C.greenSubtle, color:C.greenDark, border:"1px solid "+C.greenBorder,
                padding:"2px 8px", borderRadius:9999, fontSize:10, fontWeight:700, fontFamily:F,
                letterSpacing:".06em", textTransform:"uppercase",
              }}>
                <span style={{width:5, height:5, borderRadius:"50%", background:C.green}} className="dh-pulse"/>
                Live
              </span>
            ) : (
              <span style={{
                display:"inline-flex", alignItems:"center", gap:4,
                background:C.amberSubtle, color:C.amberDark, border:"1px solid "+C.amberBorder,
                padding:"2px 8px", borderRadius:9999, fontSize:10, fontWeight:700, fontFamily:F,
                letterSpacing:".06em", textTransform:"uppercase",
              }}>
                Preview data
              </span>
            )}
          </div>
          <p style={{margin:"4px 0 0", fontSize:14, color:C.textSub, fontFamily:F}}>
            {filtered.length === 0
              ? "No deals match your filters right now."
              : `${filtered.length} deal${filtered.length===1?"":"s"} across cash-flow markets · ${buyHoldCount} rental${buyHoldCount===1?"":"s"} · ${flipCount} flip${flipCount===1?"":"s"}`}
            {usingLive && feed?.updatedAt && (
              <span style={{color:C.textMuted}}> · Updated {timeAgo(feed.updatedAt)}</span>
            )}
            {!usingLive && !feedErr && (
              <span style={{color:C.textMuted}}> · Sample deals shown while the live feed warms up</span>
            )}
          </p>
        </div>
        {!isPro && (
          <button onClick={onUpgrade} {...btnStyle("primary","md")}>
            <I.star size={13}/> Unlock all deals
          </button>
        )}
      </div>

      {/* Filter bar */}
      <div style={{display:"flex", gap:10, marginBottom:16, flexWrap:"wrap", alignItems:"center"}}>
        {/* Strategy segmented control */}
        <StrategySegments value={strategy} onChange={setStrategy}/>

        {/* Market dropdown — dynamic from actual deal states (InvestorLift goes nationwide). */}
        <select value={market} onChange={e => setMarket(e.target.value)}
          style={{...iS(mobile), maxWidth: mobile ? "100%" : 220, paddingRight:38}}>
          <option value="all">All states</option>
          {availableMarkets.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>

        {/* Max price */}
        <div style={{position:"relative", flex:1, minWidth:140}}>
          <span style={{position:"absolute", left:12, top:"50%", transform:"translateY(-50%)",
            color:C.textMuted, fontSize:14, fontFamily:F, pointerEvents:"none"}}>$</span>
          <input
            type="text" inputMode="decimal"
            value={maxPrice ? Number(maxPrice).toLocaleString() : ""}
            onChange={e => {
              const raw = e.target.value.replace(/[^0-9]/g, "");
              setMaxPrice(raw === "" ? 0 : parseInt(raw, 10));
            }}
            placeholder="Max price"
            style={{...iS(mobile), paddingLeft:24}} />
        </div>
      </div>

      {/* Deal grid */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={<I.search size={20}/>}
          title="No deals match your filters"
          body="Try widening your price range or switching markets — fresh deals come in throughout the week."
        />
      ) : (
        <>
          <div style={{
            display:"grid",
            gridTemplateColumns: mobile ? "1fr" : isWide ? "repeat(3, 1fr)" : "repeat(2, 1fr)",
            gap:16,
          }}>
            {visible.map(({d}) => (
              <DealCard key={d.id} deal={d} isPro={isPro}
                onAnalyze={() => onAnalyzeDeal(d)}
                onSave={() => onSaveDeal(d)}
                onUpgrade={onUpgrade}
                onOpen={() => setSelectedId(d.id)}
                mobile={mobile} />
            ))}
          </div>

          {/* Upgrade CTA for free users */}
          {!isPro && lockedCount > 0 && (
            <Card style={{
              marginTop:20, padding: mobile ? "20px 18px" : "24px 28px",
              background:`linear-gradient(135deg, ${C.greenSubtle} 0%, ${C.card} 65%)`,
              borderColor:C.greenBorder,
            }}>
              <div style={{display:"flex", alignItems:"center", justifyContent:"space-between",
                gap:16, flexWrap:"wrap"}}>
                <div style={{display:"flex", alignItems:"center", gap:14, minWidth:0, flex:1}}>
                  <div style={{
                    width:42, height:42, borderRadius:C.r3, background:C.green, color:"#fff",
                    display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0,
                  }}>
                    <I.star size={20} stroke={2.2}/>
                  </div>
                  <div style={{minWidth:0}}>
                    <div style={{fontSize:16, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.01em"}}>
                      {lockedCount} more deal{lockedCount===1?"":"s"} waiting
                    </div>
                    <div style={{fontSize:13, color:C.textSub, fontFamily:F, marginTop:3, lineHeight:1.5}}>
                      Upgrade to DealHive Pro for the full feed, exact addresses, photos, and the analyzer pre-filled.
                    </div>
                  </div>
                </div>
                <button onClick={onUpgrade} {...btnStyle("primary","lg")}>
                  <I.star size={14}/> Upgrade to Pro
                </button>
              </div>
            </Card>
          )}
        </>
      )}

      {/* Detail modal — opens when a card is tapped */}
      {selectedId && (() => {
        const entry = classified.find(({d}) => d.id === selectedId);
        if (!entry) return null;
        return (
          <DealDetailModal
            deal={entry.d}
            isPro={isPro}
            onClose={() => setSelectedId(null)}
            onAnalyze={onAnalyzeDeal}
            onSave={onSaveDeal}
            onUpgrade={onUpgrade}
            mobile={mobile}
          />
        );
      })()}
    </div>
  );
}

// -- Deal Analyzer -------------------------------------------------------------
function DealAnalyzer({deals=[], onSave, onSaveToWatchlist, renoRates={light:7,medium:13,full:45}, onMoveToPortfolio, mobile, apiLookup, rentcastKey, rcAuth, onUpgrade, initial, onConsumeInitial, onBackToDeals, backLabel}) {
  // `initial` lets the Deals page hand us a pre-filled deal — we seed state once
  // on mount and then tell App to clear its prefill so a fresh visit later gets
  // a blank form again.
  const [d, setD]       = useState(() => initial ? {...newDeal(), ...initial} : newDeal());
  const [loading, setL] = useState(false);
  const [err, setErr]   = useState("");
  // Capture "came from Deals" at mount time. We use this to decide whether to
  // show the "Back to deals" button — after onConsumeInitial fires, `initial`
  // becomes null and we'd lose the signal otherwise.
  const [fromDeals]     = useState(() => !!initial);
  const [basicsLoading, setBasicsLoading] = useState(false);

  // Auto-fill beds/baths/sqft/year/type from property records (light endpoint,
  // cached, not counted against the monthly cap — the full "Pull property
  // data" button remains the counted deep fetch).
  // Picking an address runs the FULL property pull automatically — details,
  // tax records, home value, and market rent in one pass (no button). Cached
  // per address; counts as one lookup like the old Pull button did.
  const pulledKeyRef = useRef("");
  const pullProperty = loc => {
    if (!rcOk(rcAuth) || !apiLookup || !loc.address || !loc.city) return;
    const key = lookupKey("rc-detail", loc.address, loc.city, loc.state, loc.zip);
    if (pulledKeyRef.current === key) return;
    pulledKeyRef.current = key;
    setBasicsLoading(true); setErr("");
    (async () => {
      try {
        const data = await apiLookup(key, () => rentcastFetch(loc.address, loc.city, loc.state, loc.zip, rcAuth));
        if (rcHasData(data)) setD(prev => applyRentcast(prev, data, renoRates));
      } catch (e) {
        setErr(e && e.code === "CAP" ? LOOKUP_CAP_MSG : "");
      }
      setBasicsLoading(false);
    })();
  };
  const handleAddressSelect = loc => {
    setD(prev => ({...prev, ...loc, fullAddress: loc.fullAddress}));
    pullProperty(loc);
  };
  // Safety net: a full address without specs (manual typing, prefilled saves)
  // pulls after a short pause.
  useEffect(() => {
    if (d.beds || d.sqft) return;
    if (!d.address || !d.city || !d.state) return;
    const t = setTimeout(() => pullProperty({address:d.address, city:d.city, state:d.state, zip:d.zip}), 700);
    return () => clearTimeout(t);
  }, [d.address, d.city, d.state, d.zip, d.beds, d.sqft]); // eslint-disable-line react-hooks/exhaustive-deps
  // Which exit-strategy section is open (BRRRR / Fix & Flip / neither). Lifted
  // from the Calculator so the Save button and save sheet can follow it.
  // Saved deals open on their saved scenario; the auto-follow below stays
  // hands-off when the user made an explicit choice at save time.
  const [exitStrategy, setExitStrategy] = useState(() =>
    initial && (initial.savedScenario === "brrrr" || initial.savedScenario === "flip")
      ? initial.savedScenario : null);
  const u = (f,v) => setD(prev => ({...prev, [f]:v}));

  useEffect(() => {
    window.scrollTo(0, 0);
    if (initial && onConsumeInitial) onConsumeInitial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveDeal = () => {
    if (!d.address) { setErr("Enter an address first."); return; }
    if (!d.chosenStrategy) { setErr("Choose a purchase method (Cash or Finance) first."); return; }
    if (!(d.purchasePrice > 0)) { setErr("Enter a purchase price before saving — the analysis is meaningless without it."); return; }
    // Member accounts: file it on the home watchlist (opens the scenario +
    // financing picker). The form stays put so they can keep tweaking.
    if (onSaveToWatchlist) { setErr(""); onSaveToWatchlist(d, exitStrategy || "buyhold"); return; }
    onSave([...deals.filter(x => x.id !== d.id), {...d, savedAt:new Date().toISOString()}]);
    setD(newDeal()); setErr("");
  };

  const m = calc(d);

  // Which exit the recommendation would pick — mirrors the scoring inside the
  // recommendation cards below (null = Buy & Hold / Rental). Used to
  // auto-select the Explore Exit Strategies toggle until the user taps it
  // themselves.
  const recWinner = (() => {
    if (!(d.purchasePrice > 0)) return null;
    const arvW  = d.homeValueHigh || 0;
    const holdY = Math.max((m.holdMonths || 6) / 12, 0.25);
    let scores, order;
    if ((d.chosenStrategy||"finance") === "cash") {
      // Owned mode: the capital at stake is the equity already in the walls
      // plus new rehab cash, not a purchase price. Score every exit on that.
      const equity   = d.alreadyOwned ? Math.max((d.purchasePrice||0) - (d.ownedLoanBalance||0), 0) : 0;
      const spent    = d.alreadyOwned ? equity + (d.repairCosts||0) : m.cashOOP;
      const back     = d.alreadyOwned ? Math.max(m.brrrNetCash, 0) : m.brrrCashNet;
      const flipGain = d.alreadyOwned ? m.flipProfit - equity : m.flipProfit;
      const g        = brrrrGate(m, spent + m.brrrHolding, back);
      scores = {
        base:  m.cashCF > 0 && spent > 0 ? (m.cashCF*12/spent)*100 : 0,
        brrrr: !arvW ? 0 : g.score,
        flip:  !arvW || flipGain <= 0 ? 0 : spent > 0 ? (flipGain/spent)*100 / holdY : 0,
      };
    } else {
      const g = brrrrGate(m, m.finOOP + m.brrrHolding, Math.max(m.brrrNetCash, 0));
      scores = {
        base:  m.finCF > 0 ? m.finCoC : 0,
        brrrr: !arvW ? 0 : g.score,
        flip:  !arvW || m.finFlipProfit <= 0 ? 0 : m.finFlipROI / holdY,
      };
    }
    order = ["base","brrrr","flip"];
    const win = order.reduce((a,b) => scores[b] > scores[a] ? b : a, "base");
    return win === "base" ? null : win;
  })();

  // Follow the recommendation until the user taps the toggle themselves —
  // or, for reopened saved deals, not at all: the saved scenario wins.
  const exitTouched = useRef(!!(initial && initial.savedScenario));
  useEffect(() => {
    if (exitTouched.current) return;
    setExitStrategy(prev => prev === recWinner ? prev : recWinner);
  }, [recWinner]);

  // Financed exit-strategy recommendation (Rental vs BRRRR vs Fix & Flip, all
  // on the financed math). Same placement as the cash card: under ARV, above
  // the exit toggle.
  const finRecommendation = d.purchasePrice > 0 && (d.chosenStrategy||"finance") === "finance" && (() => {
    const arv = d.homeValueHigh || 0;
    const g = brrrrGate(m, m.finOOP + m.brrrHolding, Math.max(m.brrrNetCash, 0));
    const holdYears = Math.max((m.holdMonths || 6) / 12, 0.25);
    const scores = {
      rental: m.finCF > 0 ? m.finCoC : 0,
      brrrr:  !arv ? 0 : g.score,
      flip:   !arv || m.finFlipProfit <= 0 ? 0 : m.finFlipROI / holdYears,
    };
    const order = ["rental","brrrr","flip"];
    const winId = order.reduce((a,b) => scores[b] > scores[a] ? b : a, "rental");
    const NAMES = {rental:"Rental", brrrr:"BRRRR", flip:"Fix & Flip"};
    const WHY   = {
      rental: "Solid leveraged cash flow with the simplest execution.",
      brrrr:  m.brrrNetCash >= 0
        ? "The refinance pays off your loans and returns cash, and it still cash flows."
        : "Strong return on the cash left in after the refinance.",
      flip:   "Highest annualized return on your invested cash for this deal.",
    };
    const cards = [
      {id:"rental", label:"Rental", rows:[
        ["Total Cash In", $(m.finOOP), C.text],
        ["Cash Flow / mo", $mo(m.finCF), cfC(m.finCF)],
        ["Cash-on-Cash", pct(m.finCoC), C.text],
      ]},
      {id:"brrrr", label:"BRRRR", rows:[
        ["Total Invested", $(m.brrrAllIn), C.text],
        ["Net Cash at Refi", $(m.brrrNetCash), cfC(m.brrrNetCash)],
        ["Cash Flow / mo", $mo(m.brrrCF), cfC(m.brrrCF)],
      ]},
      {id:"flip", label:"Fix & Flip", rows:[
        ["Total Cash In", $(m.finOOP), C.text],
        ["Net Profit", $(m.finFlipProfit), cfC(m.finFlipProfit)],
        ["ROI on Cash", pct(m.finFlipROI), cfC(m.finFlipProfit)],
      ]},
    ];
    return (
      <Card style={{padding:20, marginBottom:16}}>
        <div style={{display:"flex", alignItems:"center", gap:10, marginBottom:14}}>
          <div style={{width:28, height:28, borderRadius:C.r2, background:C.greenSubtle, color:C.greenDark,
            display:"flex", alignItems:"center", justifyContent:"center"}}>
            <I.check size={15} stroke={2.5}/>
          </div>
          <div>
            <div style={{fontSize:11, color:C.textMuted, fontWeight:600, fontFamily:F, letterSpacing:".03em", textTransform:"uppercase"}}>Recommendation</div>
            <div style={{fontSize:16, fontWeight:600, color:C.text, fontFamily:F, letterSpacing:"-0.01em", marginTop:1}}>
              Best exit: {NAMES[winId]}
            </div>
          </div>
        </div>
        {!arv && (
          <div style={{fontSize:12.5, color:C.amberDark, background:C.amberSubtle, border:"1px solid "+C.amberBorder,
            padding:"9px 12px", borderRadius:C.r2, marginBottom:12, fontFamily:F, lineHeight:1.5}}>
            Enter an After Repair Value to bring BRRRR and Fix & Flip into the comparison.
          </div>
        )}
        <div style={{display:"grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr 1fr", gap:10, marginBottom:14}}>
          {cards.map(sv => {
            const win = winId === sv.id;
            const muted = (sv.id !== "rental") && !arv;
            return (
              <div key={sv.id} style={{
                background: win ? C.greenSubtle : C.bgSubtle,
                border: "1px solid " + (win ? C.greenBorder : C.border),
                borderRadius:C.r3, padding:"14px 16px", opacity: muted ? .55 : 1,
              }}>
                <div style={{display:"flex", alignItems:"center", gap:6, marginBottom:6, flexWrap:"wrap"}}>
                  <span style={{fontSize:12, fontWeight:600, color:win?C.greenDark:C.textSub, fontFamily:F, letterSpacing:".02em", textTransform:"uppercase"}}>{sv.label}</span>
                  {win && <Badge label="Recommended" bg={C.green} c="#fff"/>}
                </div>
                <div style={{display:"flex", flexDirection:"column", gap:6, marginTop:2}}>
                  {sv.rows.map(([l, v, color]) => (
                    <div key={l} style={{display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:10}}>
                      <span style={{fontSize:12, color:C.textSub, fontFamily:F}}>{l}</span>
                      <span style={{fontSize:14, fontWeight:700, color, fontFamily:F,
                        fontVariantNumeric:"tabular-nums", letterSpacing:"-0.01em"}}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{fontSize:13, color:C.textSub, lineHeight:1.6, fontFamily:F}}>
          {WHY[winId]}
        </div>
        {!!arv && !g.eligible && winId !== "brrrr" && (
          <div style={{fontSize:12.5, color:C.textSub, fontFamily:F, lineHeight:1.6,
            marginTop:10, paddingTop:10, borderTop:"1px solid "+C.border}}>
            <span style={{fontWeight:700, color:C.purple}}>Why not BRRRR?</span> Because {g.reason}.
          </div>
        )}
      </Card>
    );
  })();

  // Cash-tab exit-strategy recommendation. Rendered inside the Calculator via
  // midSlot so it sits right under the ARV section, above the BRRRR / Fix &
  // Flip toggle.
  const cashRecommendation = d.purchasePrice > 0 && (d.chosenStrategy||"finance") === "cash" && (() => {
        const arv = d.homeValueHigh || 0;
        // Comparable "annualized return on capital" scores for each exit. In
        // owned mode the capital is existing equity plus new rehab cash.
        const equity     = m.owned ? Math.max((d.purchasePrice||0) - m.ownedBal, 0) : 0;
        const spent      = m.owned ? equity + (d.repairCosts||0) : m.cashOOP;
        const back       = m.owned ? Math.max(m.brrrNetCash, 0) : m.brrrCashNet;
        const flipGain   = m.owned ? m.flipProfit - equity : m.flipProfit;
        const g          = brrrrGate(m, spent + m.brrrHolding, back);
        const holdYears  = Math.max((m.holdMonths || 6) / 12, 0.25);
        const scores = {
          buyhold: m.cashCF > 0 && spent > 0 ? (m.cashCF*12/spent)*100 : 0,
          brrrr:   !arv ? 0 : g.score,
          flip:    !arv || flipGain <= 0 ? 0 : spent > 0 ? (flipGain/spent)*100 / holdYears : 0,
        };
        const order  = ["buyhold","brrrr","flip"];
        const winId  = order.reduce((a,b) => scores[b] > scores[a] ? b : a, "buyhold");
        const NAMES  = {buyhold:"Rental", brrrr:"BRRRR", flip:"Fix & Flip"};
        const WHY    = {
          buyhold: "Steady cash flow with the simplest execution.",
          brrrr:   g.leftIn <= 0
            ? "The refi returns all of your capital and it still cash flows."
            : "Strong return on the capital left in after the refinance.",
          flip:    "Highest annualized return on your cash for this deal.",
        };
        const oopLabel = m.owned ? "New Cash In" : "Total Out of Pocket";
        const cards = [
          {id:"buyhold", label:"Rental", rows:[
            [oopLabel, $(m.cashOOP), C.text],
            ["Cash Flow / mo", $mo(m.cashCF), cfC(m.cashCF)],
            ["Cap Rate", pct(m.cashCap), C.text],
          ]},
          {id:"brrrr", label:"BRRRR", rows:[
            ["Total Invested", $(m.brrrAllIn), C.text],
            ["Net Cash at Refi", $(m.owned ? m.brrrNetCash : m.brrrCashNet),
              cfC(m.owned ? m.brrrNetCash : m.brrrCashNet)],
            ["Cash Flow / mo", $mo(m.brrrCF), cfC(m.brrrCF)],
          ]},
          {id:"flip", label:"Fix & Flip", rows:[
            [oopLabel, $(m.cashOOP), C.text],
            [m.owned ? "Net Cash From Sale" : "Net Profit", $(m.flipProfit), cfC(m.flipProfit)],
          ]},
        ];
        return (
          <Card style={{padding:20, marginBottom:16}}>
            <div style={{display:"flex", alignItems:"center", gap:10, marginBottom:14}}>
              <div style={{width:28, height:28, borderRadius:C.r2, background:C.greenSubtle, color:C.greenDark,
                display:"flex", alignItems:"center", justifyContent:"center"}}>
                <I.check size={15} stroke={2.5}/>
              </div>
              <div>
                <div style={{fontSize:11, color:C.textMuted, fontWeight:600, fontFamily:F, letterSpacing:".03em", textTransform:"uppercase"}}>Recommendation</div>
                <div style={{fontSize:16, fontWeight:600, color:C.text, fontFamily:F, letterSpacing:"-0.01em", marginTop:1}}>
                  Best exit: {NAMES[winId]}
                </div>
              </div>
            </div>
            {!arv && (
              <div style={{fontSize:12.5, color:C.amberDark, background:C.amberSubtle, border:"1px solid "+C.amberBorder,
                padding:"9px 12px", borderRadius:C.r2, marginBottom:12, fontFamily:F, lineHeight:1.5}}>
                Enter an After Repair Value to bring BRRRR and Fix & Flip into the comparison.
              </div>
            )}
            <div style={{display:"grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr 1fr", gap:10, marginBottom:14}}>
              {cards.map(sv => {
                const win = winId === sv.id;
                const muted = (sv.id !== "buyhold") && !arv;
                return (
                  <div key={sv.id} style={{
                    background: win ? C.greenSubtle : C.bgSubtle,
                    border: "1px solid " + (win ? C.greenBorder : C.border),
                    borderRadius:C.r3, padding:"14px 16px", opacity: muted ? .55 : 1,
                  }}>
                    <div style={{display:"flex", alignItems:"center", gap:6, marginBottom:6, flexWrap:"wrap"}}>
                      <span style={{fontSize:12, fontWeight:600, color:win?C.greenDark:C.textSub, fontFamily:F, letterSpacing:".02em", textTransform:"uppercase"}}>{sv.label}</span>
                      {win && <Badge label="Recommended" bg={C.green} c="#fff"/>}
                    </div>
                    <div style={{display:"flex", flexDirection:"column", gap:6, marginTop:2}}>
                      {sv.rows.map(([l, v, color]) => (
                        <div key={l} style={{display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:10}}>
                          <span style={{fontSize:12, color:C.textSub, fontFamily:F}}>{l}</span>
                          <span style={{fontSize:14, fontWeight:700, color, fontFamily:F,
                            fontVariantNumeric:"tabular-nums", letterSpacing:"-0.01em"}}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{fontSize:13, color:C.textSub, lineHeight:1.6, fontFamily:F}}>
              {WHY[winId]}
            </div>
            {!!arv && !g.eligible && winId !== "brrrr" && (
              <div style={{fontSize:12.5, color:C.textSub, fontFamily:F, lineHeight:1.6,
                marginTop:10, paddingTop:10, borderTop:"1px solid "+C.border}}>
                <span style={{fontWeight:700, color:C.purple}}>Why not BRRRR?</span> Because {g.reason}.
              </div>
            )}
          </Card>
        );
      })();

  return (
    <div style={{padding:mobile?"20px 16px 100px":"32px 32px"}}>
      {fromDeals && onBackToDeals && (
        <button onClick={onBackToDeals} {...btnStyle("ghost","sm", {marginBottom:14, color:C.textSub, padding:"6px 10px"})}>
          <I.arrowLeft size={14}/> {backLabel || "Back to deals"}
        </button>
      )}
      <PageHeader title="Deal Analyzer" subtitle="Analyze any deal before you make an offer"
        action={<button onClick={()=>{setD(newDeal());setErr("");}} {...btnStyle("secondary","md")}><I.x size={13}/> Clear</button>} />

      {/* Property — photo up top, then the address fields together */}
      <SectionBlock title="Property" color={C.green} icon={I.home}>
        {/* When the analyzer is prefilled from a deal (Deals page → Analyze),
            show that deal's photo carousel. Otherwise (custom address search)
            fall back to a Street View image. */}
        {Array.isArray(d.photos) && d.photos.length > 0 ? (
          <div style={{borderRadius:C.r4, overflow:"hidden", marginBottom:16,
            border:"1px solid "+C.border, boxShadow:C.sh1}}>
            <PhotoCarousel photos={d.photos}
              fallbackLat={d.lat} fallbackLng={d.lng}
              height={mobile ? 220 : 280} mobile={mobile} />
          </div>
        ) : (
          <StreetViewImg lat={d.lat} lng={d.lng} address={d.fullAddress||d.address} height={200} />
        )}
        <div style={{marginBottom:12}}>
          <label style={{fontSize:13, color:C.text, fontWeight:500, display:"block", marginBottom:6, fontFamily:F}}>
            Address
          </label>
          <AddressInput value={d.address} onChange={v=>u("address",v)}
            onSelect={handleAddressSelect}
            placeholder="Start typing an address…"
            mobile={mobile} />
        </div>
        {d.city && (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
            {[["City","city"],["State","state"],["ZIP","zip"]].map(([l,f]) => (
              <div key={f}>
                <label style={{fontSize:12, color:C.textSub, fontFamily:F, display:"block", marginBottom:5, fontWeight:500}}>{l}</label>
                <input value={d[f]||""} onChange={e=>u(f,e.target.value)} style={iS(mobile)} />
              </div>
            ))}
          </div>
        )}
        {err && (
          <div style={{display:"flex", gap:8, alignItems:"center",
            color:C.redDark, fontSize:13, marginTop:10, fontFamily:F}}>
            <I.alert size={14}/> {err}
          </div>
        )}
      </SectionBlock>

      {/* Property basics — auto-filled from records when an address is chosen */}
      {basicsLoading && !(d.beds || d.baths || d.sqft || d.yearBuilt) && (
        <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:18,
          fontSize:12.5, color:C.textSub, fontFamily:F}}>
          <span style={{width:14, height:14, borderRadius:"50%", border:"2px solid "+C.border,
            borderTopColor:C.green, animation:"dhSpin .8s linear infinite", display:"inline-block"}}/>
          Pulling property details…
        </div>
      )}
      {(d.beds > 0 || d.baths > 0 || d.sqft > 0 || d.yearBuilt > 0) && (
        <div style={{
          display:"grid", gridTemplateColumns: mobile ? "repeat(2, 1fr)" : "repeat(6, 1fr)",
          gap:1, background:C.border, border:"1px solid "+C.border,
          borderRadius:C.r4, overflow:"hidden", marginBottom:18, boxShadow:C.sh2,
        }}>
          {[
            ["Beds",     d.beds || "—",  I.bed],
            ["Baths",    d.baths || "—", I.bath],
            ["Sqft",     d.sqft ? d.sqft.toLocaleString() : "—", I.ruler],
            ["Lot Size", d.lotSize ? d.lotSize.toLocaleString() : "—", I.parcel],
            ["Year",     d.yearBuilt || "—", I.calendar],
            ["Type",     d.type || "—", I.home],
          ].map(([l, v, Ic]) => (
            <div key={l} style={{
              background:"linear-gradient(180deg, #fff 0%, #fbfbfc 100%)",
              padding:"13px 10px", textAlign:"center",
            }}>
              <div style={{
                width:32, height:32, borderRadius:9, margin:"0 auto 7px",
                background:C.greenSubtle, border:"1px solid "+C.greenBorder, color:C.greenDark,
                display:"flex", alignItems:"center", justifyContent:"center",
              }}>
                <Ic size={15} stroke={2}/>
              </div>
              <div style={{fontSize:15, fontWeight:700, color:C.text, fontFamily:F,
                fontVariantNumeric:"tabular-nums", letterSpacing:"-0.015em",
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{v}</div>
              <div style={{fontSize:11, color:C.textSub, fontFamily:F, fontWeight:700,
                letterSpacing:".06em", textTransform:"uppercase", marginTop:2}}>{l}</div>
            </div>
          ))}
        </div>
      )}

      {/* Calculator */}
      <Calculator p={d} set={setD} renoRates={renoRates} mobile={mobile} apiLookup={apiLookup} rentcastKey={rentcastKey} rcAuth={rcAuth} onUpgrade={onUpgrade}
        exit={exitStrategy} onExitChange={v => { exitTouched.current = true; setExitStrategy(v); }} externalSummary
        midSlot={(d.chosenStrategy||"finance") === "cash" ? cashRecommendation : finRecommendation}
        stickyTop="calc(env(safe-area-inset-top, 0px) + 54px)" />

      {/* Summary — always right above Notes (once a method is chosen) */}
      {d.chosenStrategy && <DealSummaryBlock p={d} m={m} exit={exitStrategy}/>}

      {/* Deal Notes */}
      <SectionBlock title="Notes" color={C.sidebar} icon={I.edit}>
        <textarea value={d.notes||""} onChange={e=>u("notes",e.target.value)}
          placeholder="Seller motivation, condition, neighborhood, rehab scope…"
          style={{...iS(mobile), minHeight:110, resize:"vertical", lineHeight:1.55}} />
      </SectionBlock>

      {/* Save */}
      {err && (
        <div style={{display:"flex", gap:8, alignItems:"center", color:C.redDark,
          background:C.redSubtle, border:"1px solid "+C.redBorder, borderRadius:C.r2,
          padding:"10px 12px", fontSize:13, marginBottom:12, fontFamily:F}}>
          <I.alert size={14}/> {err}
        </div>
      )}
      <button onClick={saveDeal}
        {...btnStyle("primary","lg", {width:"100%", marginBottom:24})}>
        <I.star size={15}/> Save as {exitStrategy === "brrrr" ? "BRRRR"
          : exitStrategy === "flip" ? "Fix & Flip"
          : d.alreadyOwned || (d.chosenStrategy||"finance") === "finance" ? "Rental" : "Buy & Hold"}
      </button>

      {/* Saved Deals */}
      {deals.length > 0 && (
        <div>
          <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14}}>
            <div style={{fontSize:12, fontWeight:600, color:C.textSub, fontFamily:F, letterSpacing:".03em", textTransform:"uppercase"}}>
              Saved deals
            </div>
            <span style={{fontSize:12, color:C.textMuted, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>{deals.length} total</span>
          </div>
          <div style={{display:"grid",gridTemplateColumns:mobile?"1fr":"1fr 1fr",gap:14}}>
            {[...deals].sort((a,b)=>new Date(b.savedAt)-new Date(a.savedAt)).map(deal => {
              const dm = calc(deal);
              return (
                <Card key={deal.id} padding={0}>
                  {deal.lat && deal.lng && (
                    <div style={{height:120, overflow:"hidden", position:"relative", background:C.bgSubtle}}>
                      <SafeImg src={svUrl(deal.lat,deal.lng,900,200)}
                        style={{width:"100%",height:"100%",objectFit:"cover"}} />
                      <div style={{position:"absolute",inset:0,background:"linear-gradient(to bottom,transparent 35%,rgba(9,9,11,.7))"}} />
                      <div style={{position:"absolute",bottom:10,left:14,right:14,
                        color:"white", fontWeight:600, fontSize:13, fontFamily:F, letterSpacing:"-0.005em",
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{deal.address}</div>
                    </div>
                  )}
                  <div style={{padding:14}}>
                    {!deal.lat && (
                      <div style={{fontWeight:600, fontSize:14, color:C.text, fontFamily:F, letterSpacing:"-0.005em", marginBottom:4,
                        overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{deal.address}</div>
                    )}
                    <div style={{fontSize:12, color:C.textMuted, fontFamily:F, marginBottom:10}}>
                      {deal.city}, {deal.state} · {new Date(deal.savedAt).toLocaleDateString()}
                    </div>
                    {deal.notes && (
                      <div style={{fontSize:12, color:C.textSub, fontFamily:F, marginBottom:10, fontStyle:"italic", lineHeight:1.5,
                        overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>"{deal.notes}"</div>
                    )}
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:1, marginBottom:12,
                      background:C.border, borderRadius:C.r2, overflow:"hidden", border:"1px solid "+C.border}}>
                      {[["CF/mo",$mo(dm.chosenCF),cfC(dm.chosenCF)],["CoC",pct(dm.chosenCoC),cfC(dm.chosenCoC)],
                        ["Cap rate",pct(dm.chosenCap)],["Out of pocket",$(dm.chosenOOP)]].map(([l,v,c]) => (
                        <div key={l} style={{background:C.card, padding:"8px 10px"}}>
                          <div style={{fontSize:11.5, color:C.textSub, fontFamily:F, fontWeight:500, letterSpacing:".03em", textTransform:"uppercase"}}>{l}</div>
                          <div style={{fontSize:13, fontWeight:700, color:c||C.text, fontFamily:F, marginTop:2, fontVariantNumeric:"tabular-nums", letterSpacing:"-0.005em"}}>{v}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{display:"flex", gap:6}}>
                      <button onClick={()=>setD(deal)} {...btnStyle("secondary","sm")}>Load</button>
                      <button onClick={()=>onMoveToPortfolio(deal)}
                        {...btnStyle("primary","sm", {flex:1})}>Add to portfolio <I.arrowRight size={13}/></button>
                      <button onClick={()=>onSave(deals.filter(x=>x.id!==deal.id))}
                        {...btnStyle("ghost","sm", {color:C.textMuted, padding:"5px 7px"})} aria-label="Delete">
                        <I.trash size={14}/>
                      </button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Small Leaflet map for the Comps page — shows the searched property plus
// each comp so the user can see how far away each is. Color-coded per mode
// (orange for rent, blue for sale). Loads Leaflet on demand if it isn't
// already on the page.
function CompsMap({ center, comps, mode, mobile }) {
  const ref  = useRef(null);
  const inst = useRef(null);
  const [ready, setReady] = useState(!!window.L);

  useEffect(() => {
    if (window.L) { setReady(true); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    s.onload = () => setReady(true);
    document.head.appendChild(s);
    const l = document.createElement("link");
    l.rel  = "stylesheet";
    l.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(l);
  }, []);

  useEffect(() => {
    if (!ready || !ref.current || !center) return;
    if (inst.current) { inst.current.remove(); inst.current = null; }
    const L = window.L;
    const accent = mode === "rent" ? "#E8731C" : "#2563eb";
    const map = L.map(ref.current, { zoomControl:true, scrollWheelZoom:false }).setView([center.lat, center.lng], 14);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution:"(c) OpenStreetMap" }).addTo(map);

    const subjectIcon = L.divIcon({
      className:"dh-comp-subject",
      html:`<div style="width:18px;height:18px;border-radius:50%;background:${accent};border:3px solid white;box-shadow:0 0 0 2px ${accent};"></div>`,
      iconSize:[18,18], iconAnchor:[9,9],
    });
    L.marker([center.lat, center.lng], { icon:subjectIcon, zIndexOffset:1000 }).addTo(map).bindPopup("<b>Your search</b>");

    const compIcon = L.divIcon({
      className:"dh-comp-marker",
      html:`<div style="width:12px;height:12px;border-radius:50%;background:white;border:2.5px solid ${accent};box-shadow:0 1px 3px rgba(0,0,0,.25);"></div>`,
      iconSize:[12,12], iconAnchor:[6,6],
    });

    const bounds = [[center.lat, center.lng]];
    (comps||[]).forEach(c => {
      if (!c.latitude || !c.longitude) return;
      const m = L.marker([c.latitude, c.longitude], { icon:compIcon }).addTo(map);
      const priceNum = c.price || c.rent || 0;
      const priceLabel = mode === "rent" ? "$"+priceNum.toLocaleString()+"/mo" : "$"+priceNum.toLocaleString();
      const dist = c.distance != null ? " &middot; "+Number(c.distance).toFixed(2)+" mi" : "";
      const addr = (c.formattedAddress||c.address||"").replace(/</g,"&lt;");
      m.bindPopup(`<strong>${priceLabel}</strong>${dist}<br/>${addr}`);
      bounds.push([c.latitude, c.longitude]);
    });
    if (bounds.length > 1) map.fitBounds(bounds, { padding:[30,30], maxZoom:15 });

    inst.current = map;
    return () => { if (inst.current) { inst.current.remove(); inst.current = null; } };
  }, [ready, center, comps, mode]);

  return (
    <div style={{marginBottom:20, borderRadius:C.r3, overflow:"hidden", border:"1px solid "+C.border, background:C.bgSubtle}}>
      <div ref={ref} style={{ height: mobile ? 220 : 300, width:"100%" }} />
    </div>
  );
}

// -- Comps ---------------------------------------------------------------------
function LeaseComps({rentcastKey, onSaveKey, mobile, apiLookup}) {
  const [address,setAddress] = useState("");
  const [location,setLocation] = useState(null);
  const [beds,setBeds]         = useState(3);
  const [autoDetected,setAuto] = useState(false);
  const [mode,setMode]         = useState("rent");        // "rent" | "sale"
  const [loading,setL]         = useState(false);
  const [rentComps,setRentComps] = useState(null);
  const [saleComps,setSaleComps] = useState(null);
  const [err,setErr]           = useState("");

  const handleSelect = async loc => {
    setAddress(loc.fullAddress||loc.address); setLocation(loc);
    if (!rentcastKey) return;
    try {
      const addr = loc.fullAddress||loc.address;
      // Bedroom auto-detect — cached so repeats are free, and not counted
      // against the monthly cap (it's a convenience, not a real lookup).
      const d = await apiLookup(lookupKey("rc-prop", addr), async () => {
        const q = encodeURIComponent(addr);
        const r = await fetch("https://api.rentcast.io/v1/properties?address="+q, {headers:{"X-Api-Key":rentcastKey}});
        return r.json();
      }, {count:false});
      if (d?.[0]?.bedrooms) { setBeds(d[0].bedrooms); setAuto(true); }
    } catch {}
  };

  // Run only the active mode's search — the user picks one or the other, so
  // we don't fan out to all endpoints.
  const search = async () => {
    if (!rentcastKey) { setErr("Live comps are currently unavailable."); return; }
    if (!address)     { setErr("Enter an address first."); return; }
    setL(true); setErr("");
    try {
      const q = encodeURIComponent(address);
      const h = {"X-Api-Key":rentcastKey};
      if (mode === "rent") {
        // Rent estimate + active rental listings, billed as one lookup.
        const result = await apiLookup(lookupKey("rc-rent-comp", address, beds), async () => {
          const r  = await fetch("https://api.rentcast.io/v1/avm/rent/long-term?address="+q+"&bedrooms="+beds, {headers:h});
          const d  = await r.json();
          let listings = [];
          try {
            const r2 = await fetch("https://api.rentcast.io/v1/listings/rental/long-term?address="+q+"&bedrooms="+beds+"&radius=1&limit=12&status=Active", {headers:h});
            const d2 = await r2.json();
            listings = Array.isArray(d2) ? d2 : (d2?.listings||[]);
          } catch {}
          return {estimate:d, listings};
        });
        setRentComps(result);
      } else {
        // Sale value estimate + recent sale comparables.
        const result = await apiLookup(lookupKey("rc-sale-comp", address, beds), async () => {
          const r = await fetch("https://api.rentcast.io/v1/avm/value?address="+q+"&bedrooms="+beds, {headers:h});
          const d = await r.json();
          return (d && (d.price || d.priceRangeLow)) ? d : {};
        });
        setSaleComps(result);
      }
    } catch (e) { setErr(e && e.code === "CAP" ? LOOKUP_CAP_MSG : "Search failed. Check the address and try again."); }
    setL(false);
  };

  const avg = rentComps?.listings?.length
    ? Math.round(rentComps.listings.reduce((s,l)=>s+(l.price||l.rent||0),0)/rentComps.listings.length)
    : 0;

  return (
    <div style={{padding:mobile?"20px 16px 100px":"32px 32px"}}>
      <PageHeader title="Comps" subtitle="Real rental and sale comps for any address" />

      <SectionBlock title="Search comps" color={C.green}>
        {/* Rent vs Sale tabs — only the active mode's search runs */}
        <div style={{display:"flex", gap:0, marginBottom:14, padding:4,
          background:C.bgSubtle, borderRadius:C.r2, border:"1px solid "+C.border}}>
          {[["rent","Rent comps"],["sale","Sale comps"]].map(([id,label]) => {
            const active = mode===id;
            return (
              <button key={id} type="button" onClick={()=>{setMode(id); setErr("");}}
                style={{
                  flex:1, padding:"7px 14px", borderRadius:C.r1, border:"none",
                  background: active ? C.card : "transparent",
                  color: active ? C.text : C.textSub,
                  fontWeight: active?600:500, fontSize:13, cursor:"pointer", fontFamily:F,
                  letterSpacing:"-0.005em",
                  boxShadow: active ? C.sh1 : "none",
                  transition:"background .15s, color .15s, box-shadow .15s",
                }}>
                {label}
              </button>
            );
          })}
        </div>
        <div style={{marginBottom:14}}>
          <label style={{fontSize:13, color:C.text, fontWeight:500, display:"block", marginBottom:6, fontFamily:F}}>Address</label>
          <AddressInput value={address} onChange={setAddress} onSelect={handleSelect}
            placeholder={mode==="rent" ? "Enter an address to find nearby rentals…" : "Enter an address to find recent sales…"} mobile={mobile} />
        </div>
        <div style={{marginBottom:14}}>
          <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:6}}>
            <label style={{fontSize:13, color:C.text, fontWeight:500, fontFamily:F}}>Bedrooms</label>
            {autoDetected && <Badge label="Auto-detected" bg={C.greenLight} c={C.greenDark} dot/>}
          </div>
          <select value={beds} onChange={e=>{setBeds(parseInt(e.target.value));setAuto(false);}} style={iS(mobile)}>
            {[1,2,3,4,5,6].map(n => <option key={n} value={n}>{n} bedroom{n>1?"s":""}</option>)}
          </select>
        </div>
        <div style={{display:"flex", gap:8, alignItems:"center"}}>
          <button onClick={search} disabled={loading}
            {...btnStyle("primary","md", {flex:1})}>
            {loading ? "Searching…" : <><I.search size={14}/> Find {mode==="rent" ? "rent" : "sale"} comps</>}
          </button>
        </div>
        {err && (
          <div style={{display:"flex", gap:8, alignItems:"center", color:C.redDark, fontSize:13, marginTop:10, fontFamily:F}}>
            <I.alert size={14}/> {err}
          </div>
        )}
      </SectionBlock>

      {location && <StreetViewImg lat={location.lat} lng={location.lng} address={address} height={180} />}

      {/* Rent comps results */}
      {mode === "rent" && rentComps && (
        <div>
          {rentComps.estimate?.rent && (
            <Card style={{padding:24, marginBottom:20, marginTop:6,
              background:"linear-gradient(180deg, #fff 0%, "+C.greenSubtle+" 100%)",
              borderColor:C.greenBorder}}>
              <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:8}}>
                <span style={{fontSize:11, fontWeight:600, color:C.greenDark, fontFamily:F, letterSpacing:".04em", textTransform:"uppercase"}}>
                  Market rent estimate · {beds} bed
                </span>
              </div>
              <div style={{fontSize:42, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.03em", lineHeight:1, fontVariantNumeric:"tabular-nums"}}>
                {$(rentComps.estimate.rent)}<span style={{fontSize:18, color:C.textSub, fontWeight:500}}>/mo</span>
              </div>
              <div style={{fontSize:13, color:C.textSub, fontFamily:F, marginTop:8, fontVariantNumeric:"tabular-nums"}}>
                Range {$(rentComps.estimate.rentRangeLow)} – {$(rentComps.estimate.rentRangeHigh)}/mo
                {avg > 0 && <> · Avg of {rentComps.listings.length} listings: <b style={{color:C.text, fontWeight:600}}>{$(avg)}</b></>}
              </div>
            </Card>
          )}
          {(location || rentComps.estimate?.latitude) && (
            <CompsMap mobile={mobile} mode="rent"
              center={location ? {lat:location.lat, lng:location.lng} : {lat:rentComps.estimate.latitude, lng:rentComps.estimate.longitude}}
              comps={rentComps.listings||[]} />
          )}
          {rentComps.listings?.length > 0 ? (
            <div>
              <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14}}>
                <div style={{fontSize:12, fontWeight:600, color:C.textSub, fontFamily:F, letterSpacing:".03em", textTransform:"uppercase"}}>
                  Active listings
                </div>
                <span style={{fontSize:12, color:C.textMuted, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>{rentComps.listings.length} found</span>
              </div>
              <div style={{display:"grid", gridTemplateColumns:mobile?"1fr":"repeat(auto-fill,minmax(280px,1fr))", gap:14}}>
                {rentComps.listings.slice().sort((a,b)=>(a.distance??1e9)-(b.distance??1e9)).map((l,i) => {
                  const rent = l.price||l.rent||0;
                  const img  = l.photoUrl||(l.photos?.[0]?.url)||null;
                  return (
                    <Card key={l.id||i} hover padding={0}>
                      <div style={{height:170, background:C.bgSubtle, position:"relative"}}>
                        <SafeImg src={img || ((l.latitude&&l.longitude) ? svUrl(l.latitude,l.longitude,800,340) : null)}
                          fallback={imgPlaceholder()}
                          style={{width:"100%",height:"100%",objectFit:"cover"}} />
                        <div style={{position:"absolute",top:10,right:10}}>
                          <Badge label="Active" bg={C.greenLight} c={C.greenDark} dot/>
                        </div>
                        {l.distance && (
                          <div style={{position:"absolute", bottom:10, left:10,
                            background:"rgba(9,9,11,.7)", color:"white",
                            padding:"3px 8px", borderRadius:C.rFull,
                            fontSize:11, fontFamily:F, fontWeight:500, fontVariantNumeric:"tabular-nums"}}>
                            {l.distance.toFixed(1)} mi
                          </div>
                        )}
                      </div>
                      <div style={{padding:14}}>
                        <div style={{fontWeight:700, fontSize:22, color:C.text, fontFamily:F, fontVariantNumeric:"tabular-nums", letterSpacing:"-0.025em"}}>
                          {$(rent)}<span style={{fontSize:13, color:C.textSub, fontWeight:500}}>/mo</span>
                        </div>
                        <div style={{fontSize:13, color:C.text, fontWeight:500, marginTop:4, fontFamily:F, letterSpacing:"-0.005em",
                          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
                          {l.formattedAddress||l.address}
                        </div>
                        <div style={{display:"flex", gap:14, marginTop:10, flexWrap:"wrap", fontVariantNumeric:"tabular-nums"}}>
                          {l.bedrooms   && <span style={{fontSize:12, color:C.textSub, fontFamily:F}}>{l.bedrooms} bd</span>}
                          {l.bathrooms  && <span style={{fontSize:12, color:C.textSub, fontFamily:F}}>{l.bathrooms} ba</span>}
                          {l.squareFootage && <span style={{fontSize:12, color:C.textSub, fontFamily:F}}>{l.squareFootage.toLocaleString()} sqft</span>}
                        </div>
                        {l.listedDate && (
                          <div style={{fontSize:11, color:C.textMuted, marginTop:10, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>
                            Listed {new Date(l.listedDate).toLocaleDateString()}
                          </div>
                        )}
                        {l.latitude && l.longitude && (
                          <a href={"https://www.google.com/maps?q="+l.latitude+","+l.longitude}
                            target="_blank" rel="noreferrer"
                            {...btnStyle("secondary","sm", {marginTop:12, width:"100%"})}>
                            <I.pin size={12}/> Open in Maps
                          </a>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          ) : (
            <EmptyState
              icon={<I.search size={20}/>}
              title="No active listings nearby"
              body="Try a wider search area or different bedroom count. The market estimate above is still valid."
            />
          )}
        </div>
      )}

      {/* Sale comps results */}
      {mode === "sale" && saleComps && (
        <div>
          {saleComps.price > 0 && (
            <Card style={{padding:24, marginBottom:20, marginTop:6,
              background:"linear-gradient(180deg, #fff 0%, "+C.blueSubtle+" 100%)",
              borderColor:C.blueBorder}}>
              <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:8}}>
                <span style={{fontSize:11, fontWeight:600, color:C.blueDark, fontFamily:F, letterSpacing:".04em", textTransform:"uppercase"}}>
                  Estimated sale value · {beds} bed
                </span>
              </div>
              <div style={{fontSize:42, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.03em", lineHeight:1, fontVariantNumeric:"tabular-nums"}}>
                {$(saleComps.price)}
              </div>
              <div style={{fontSize:13, color:C.textSub, fontFamily:F, marginTop:8, fontVariantNumeric:"tabular-nums"}}>
                Range {$(saleComps.priceRangeLow)} – {$(saleComps.priceRangeHigh)}
                {saleComps.comparables?.length > 0 && <> · Based on {saleComps.comparables.length} recent sales</>}
              </div>
            </Card>
          )}
          {(location || saleComps.latitude) && (
            <CompsMap mobile={mobile} mode="sale"
              center={location ? {lat:location.lat, lng:location.lng} : {lat:saleComps.latitude, lng:saleComps.longitude}}
              comps={saleComps.comparables||[]} />
          )}
          {saleComps.comparables?.length > 0 ? (
            <div>
              <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14}}>
                <div style={{fontSize:12, fontWeight:600, color:C.textSub, fontFamily:F, letterSpacing:".03em", textTransform:"uppercase"}}>
                  Sale comps
                </div>
                <span style={{fontSize:12, color:C.textMuted, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>{saleComps.comparables.length} found</span>
              </div>
              <div style={{display:"grid", gridTemplateColumns:mobile?"1fr":"repeat(auto-fill,minmax(280px,1fr))", gap:14}}>
                {saleComps.comparables.slice().sort((a,b)=>(a.distance??1e9)-(b.distance??1e9)).map((c,i) => {
                  const soldDate = c.removedDate || c.lastSeenDate || c.listedDate;
                  return (
                    <Card key={c.id||i} hover padding={0}>
                      <div style={{height:170, background:C.bgSubtle, position:"relative"}}>
                        <SafeImg src={(c.latitude && c.longitude) ? svUrl(c.latitude,c.longitude,800,340) : null}
                          fallback={imgPlaceholder()}
                          style={{width:"100%",height:"100%",objectFit:"cover"}} />
                        <div style={{position:"absolute", top:10, right:10}}>
                          <Badge label="Sold" bg={C.blueLight} c={C.blueDark} dot/>
                        </div>
                        {c.distance != null && (
                          <div style={{position:"absolute", bottom:10, left:10,
                            background:"rgba(9,9,11,.7)", color:"white",
                            padding:"3px 8px", borderRadius:C.rFull,
                            fontSize:11, fontFamily:F, fontWeight:500, fontVariantNumeric:"tabular-nums"}}>
                            {Number(c.distance).toFixed(1)} mi
                          </div>
                        )}
                      </div>
                      <div style={{padding:14}}>
                        <div style={{fontWeight:700, fontSize:22, color:C.text, fontFamily:F, fontVariantNumeric:"tabular-nums", letterSpacing:"-0.025em"}}>
                          {$(c.price||0)}
                        </div>
                        <div style={{fontSize:13, color:C.text, fontWeight:500, marginTop:4, fontFamily:F, letterSpacing:"-0.005em",
                          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
                          {c.formattedAddress || c.address}
                        </div>
                        <div style={{display:"flex", gap:14, marginTop:10, flexWrap:"wrap", fontVariantNumeric:"tabular-nums"}}>
                          {c.bedrooms     && <span style={{fontSize:12, color:C.textSub, fontFamily:F}}>{c.bedrooms} bd</span>}
                          {c.bathrooms    && <span style={{fontSize:12, color:C.textSub, fontFamily:F}}>{c.bathrooms} ba</span>}
                          {c.squareFootage && <span style={{fontSize:12, color:C.textSub, fontFamily:F}}>{c.squareFootage.toLocaleString()} sqft</span>}
                          {c.yearBuilt    && <span style={{fontSize:12, color:C.textMuted, fontFamily:F}}>Built {c.yearBuilt}</span>}
                        </div>
                        {soldDate && (
                          <div style={{fontSize:11, color:C.textMuted, marginTop:10, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>
                            Sold {new Date(soldDate).toLocaleDateString()}
                          </div>
                        )}
                        {c.latitude && c.longitude && (
                          <a href={"https://www.google.com/maps?q="+c.latitude+","+c.longitude}
                            target="_blank" rel="noreferrer"
                            {...btnStyle("secondary","sm", {marginTop:12, width:"100%"})}>
                            <I.pin size={12}/> Open in Maps
                          </a>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          ) : (
            <EmptyState
              icon={<I.search size={20}/>}
              title="No recent sales nearby"
              body="Try a wider area or different bedroom count."
            />
          )}
        </div>
      )}
    </div>
  );
}

// -- Settings ------------------------------------------------------------------
function SettingsPage({onSignOut, mobile, userEmail, tier="free", onUpgrade, onDowngrade, billing=null, billingBusy=false, isAdmin=false}) {
  const isPro = tier === "pro";
  const periodEnd = billing && billing.currentPeriodEnd
    ? new Date(billing.currentPeriodEnd).toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric"})
    : null;
  return (
    <div style={{padding:mobile?"20px 16px 100px":"32px 32px", maxWidth:680}}>
      <PageHeader title="Settings"/>
      <SectionBlock title="Account" color={C.green}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", gap:12}}>
          <div style={{display:"flex", alignItems:"center", gap:12, minWidth:0}}>
            <div style={{
              width:38, height:38, borderRadius:"50%", background:C.bgSubtle,
              display:"flex", alignItems:"center", justifyContent:"center",
              color:C.textSub, fontSize:15, fontWeight:600, fontFamily:F, flexShrink:0,
            }}>{(userEmail||"?")[0].toUpperCase()}</div>
            <div style={{minWidth:0}}>
              <div style={{fontSize:14, fontWeight:600, color:C.text, fontFamily:F, letterSpacing:"-0.005em",
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{userEmail}</div>
              <div style={{fontSize:12, color:C.textMuted, fontFamily:F, marginTop:2}}>Signed in</div>
            </div>
          </div>
          <button onClick={onSignOut} {...btnStyle("secondary","md")}>Sign out</button>
        </div>
      </SectionBlock>

      <SectionBlock title="Subscription" color={C.green}>
        <div style={{
          background: isPro
            ? `linear-gradient(135deg, ${C.greenSubtle} 0%, ${C.card} 70%)`
            : C.bgSubtle,
          border:"1px solid "+(isPro ? C.greenBorder : C.border),
          borderRadius:C.r3, padding:"14px 16px",
          display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, flexWrap:"wrap",
        }}>
          <div style={{display:"flex", alignItems:"center", gap:12, minWidth:0}}>
            <div style={{
              width:38, height:38, borderRadius:C.r3,
              background: isPro ? C.green : C.card, color: isPro ? "#fff" : C.textMuted,
              border:"1px solid "+(isPro ? C.green : C.border),
              display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0,
            }}>
              <I.star size={18} stroke={2.2}/>
            </div>
            <div style={{minWidth:0}}>
              <div style={{display:"flex", alignItems:"center", gap:8}}>
                <span style={{fontSize:14, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.005em"}}>
                  DealHive {isPro ? "Pro" : "Free"}
                </span>
                {isPro && <Badge label="Active" bg={C.greenLight} c={C.greenDark} dot/>}
              </div>
              <div style={{fontSize:12, color:C.textSub, fontFamily:F, marginTop:2, lineHeight:1.5}}>
                {isPro
                  ? (periodEnd
                      ? (billing && billing.cancelAtPeriodEnd
                          ? `Cancels on ${periodEnd} — you keep Pro until then.`
                          : `Renews on ${periodEnd} at $29.99/month.`)
                      : "Full access to all deals, exact addresses, unlimited saves, and every photo.")
                  : "Upgrade for the full deal feed, exact addresses, unlimited saves, and every photo. $29.99/month, cancel anytime."}
              </div>
            </div>
          </div>
          {isPro ? (
            isAdmin ? (
              <button onClick={onDowngrade} {...btnStyle("secondary","md")}>Switch to Free</button>
            ) : billing && billing.customerId ? (
              <button onClick={onDowngrade} disabled={billingBusy} {...btnStyle("secondary","md")}>
                {billingBusy ? "Opening…" : "Manage Billing"}
              </button>
            ) : (
              <Badge label="Complimentary access" bg={C.greenLight} c={C.greenDark} dot/>
            )
          ) : (
            <button onClick={onUpgrade} disabled={billingBusy} {...btnStyle("primary","md")}>
              <I.star size={13}/> {billingBusy ? "Opening checkout…" : "Upgrade to Pro"}
            </button>
          )}
        </div>
      </SectionBlock>

      <div style={{display:"flex", gap:16, justifyContent:"center", padding:"6px 0 0"}}>
        {[["Privacy Policy","/privacy"],["Terms of Use","/terms"]].map(([label, href]) => (
          <a key={href} href={href} target="_blank" rel="noreferrer"
            style={{fontSize:12, color:C.textMuted, fontFamily:F, textDecoration:"none"}}>
            {label}
          </a>
        ))}
      </div>
    </div>
  );
}

// -- Add Property Modal --------------------------------------------------------
function AddPropertyModal({llcs, onAdd, onClose, renoRates, mobile, apiLookup, rentcastKey, rcAuth}) {
  const [p,setP]       = useState(() => newProp());
  const [loading,setL] = useState(false);
  const [err,setErr]   = useState("");
  const u = (f,v) => setP(prev => ({...prev,[f]:v}));

  // Close on Escape. (Body scroll lock is owned by the App component, tied
  // directly to the showAdd flag, so it can't get "stuck" on unmount.)
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const pullData = async (addr, city, state, zip) => {
    if (!addr) { setErr("Enter an address first."); return; }
    if (!rcOk(rcAuth)) { setErr("Live property data is currently unavailable."); return; }
    setL(true); setErr("");
    try {
      const key = lookupKey("rc-detail", addr, city, state, zip);
      const data = await apiLookup(key, () => rentcastFetch(addr, city, state, zip, rcAuth));
      if (!rcHasData(data)) setErr("No public records found for that address yet — you can fill the details in manually.");
      else setP(prev => applyRentcast(prev, data, renoRates));
    } catch (e) { setErr(e && e.code === "CAP" ? LOOKUP_CAP_MSG : "Auto-fill failed."); }
    setL(false);
  };
  const runSearch = () => pullData(p.address, p.city, p.state, p.zip);

  const outerStyle = mobile
    ? {position:"fixed", inset:0, background:"rgba(9,9,11,.55)", zIndex:500, display:"flex", alignItems:"flex-end",
       backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)"}
    : {position:"fixed", inset:0, background:"rgba(9,9,11,.45)", zIndex:500, display:"flex", alignItems:"center", justifyContent:"center", padding:20,
       backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)"};
  const innerStyle = mobile
    ? {background:C.card, borderRadius:"18px 18px 0 0", width:"100%", maxHeight:"92dvh", overflowY:"auto", overscrollBehavior:"contain",
       padding:"24px 20px calc(40px + env(safe-area-inset-bottom, 0px))",
       paddingLeft:"max(20px, calc(20px + env(safe-area-inset-left, 0px)))",
       paddingRight:"max(20px, calc(20px + env(safe-area-inset-right, 0px)))",
       boxShadow:C.sh4, WebkitOverflowScrolling:"touch"}
    : {background:C.card, borderRadius:C.r5, width:"100%", maxWidth:540, maxHeight:"88dvh", overflowY:"auto", padding:28, boxShadow:C.sh4, border:"1px solid "+C.border};

  return (
    <div style={outerStyle} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={innerStyle}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18}}>
          <div>
            <h2 style={{margin:0, fontSize:18, fontWeight:600, color:C.text, fontFamily:F, letterSpacing:"-0.02em"}}>Add property</h2>
            <p style={{margin:"3px 0 0", fontSize:13, color:C.textSub, fontFamily:F}}>Track a new rental in your portfolio.</p>
          </div>
          <button onClick={onClose}
            style={{background:C.card, border:"1px solid "+C.border, borderRadius:C.r2, width:32, height:32,
              cursor:"pointer", color:C.textSub, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:C.sh1}}
            aria-label="Close">
            <I.x size={15}/>
          </button>
        </div>
        <div style={{marginBottom:14}}>
          <label style={{fontSize:13, color:C.text, fontWeight:500, display:"block", marginBottom:6, fontFamily:F}}>Address</label>
          <AddressInput value={p.address} onChange={v=>u("address",v)}
            onSelect={loc=>{
              setP(prev=>({...prev,address:loc.address,city:loc.city,state:loc.state,zip:loc.zip,lat:loc.lat,lng:loc.lng}));
              pullData(loc.address, loc.city, loc.state, loc.zip);
            }}
            placeholder="Start typing an address…"
            mobile={mobile} />
        </div>
        <StreetViewImg lat={p.lat} lng={p.lng} address={p.address} height={150} />
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginTop:6, marginBottom:14}}>
          {[["City","city"],["State","state"],["ZIP","zip"]].map(([l,f]) => (
            <div key={f}>
              <label style={{fontSize:12, color:C.textSub, fontFamily:F, display:"block", marginBottom:5, fontWeight:500}}>{l}</label>
              <input value={p[f]||""} onChange={e=>u(f,e.target.value)} style={iS(mobile)} />
            </div>
          ))}
        </div>
        <button onClick={runSearch} disabled={loading}
          {...btnStyle("secondary","md", {width:"100%", marginBottom:14})}>
          {loading ? "Searching…" : <><I.search size={13}/> Auto-fill from public records</>}
        </button>
        {err && (
          <div style={{display:"flex", gap:8, alignItems:"center", color:C.redDark, fontSize:13, marginBottom:12, fontFamily:F}}>
            <I.alert size={14}/> {err}
          </div>
        )}
        <SelectField label="Ownership" value={p.llc} onChange={v=>u("llc",v)} options={[["","Choose an LLC…"], ...llcs]} mobile={mobile}/>
        <InputField label="Purchase price" val={p.purchasePrice||0} set={v=>u("purchasePrice",v)} pre="$" mobile={mobile} />
        <InputField label="Expected rent" val={p.rentAmount||0} set={v=>u("rentAmount",v)} pre="$" suf="/mo"
          note={p.rentEstimate>0?"Est. "+$(p.rentEstimate)+"/mo":""} mobile={mobile} />
        <button onClick={()=>onAdd(p)}
          {...btnStyle("primary","lg", {width:"100%", marginTop:8})}>
          Add to portfolio
        </button>
      </div>
    </div>
  );
}

// -- Desktop Sidebar -----------------------------------------------------------
// `adminOnly` items are hidden from regular members — they live behind
// data.role === "admin". The portfolio/property-management surface (Properties,
// Projects) is admin-only; everyone else gets a deal-finder app focused on
// Deals, Analyzer, Comps, and a Saved Deals dashboard.
const NAV_ITEMS = [
  {id:"dashboard",  Icon:I.home,           label:"Dashboard"},
  {id:"deals",      Icon:I.star,           label:"Deals"},
  {id:"properties", Icon:I.building,       label:"Properties", adminOnly:true},
  {id:"projects",   Icon:I.clipboardCheck, label:"Projects",   adminOnly:true},
  {id:"deal",       Icon:I.search,         label:"Deal Analyzer"},
  {id:"comps",      Icon:I.chart,          label:"Comps",      adminOnly:true},
  {id:"settings",   Icon:I.settings,       label:"Settings"},
];

function DesktopSidebar({page, setPage, daysLeft, userEmail, isAdmin}) {
  return (
    <div style={{width:230, background:C.sidebar, height:"100vh", position:"fixed",
      left:0, top:0, display:"flex", flexDirection:"column", zIndex:100,
      borderRight:"1px solid rgba(255,255,255,.06)"}}>
      <div style={{background:"#fff", padding:"11px 20px 10px", display:"flex", alignItems:"center", justifyContent:"center", borderBottom:"2px solid "+C.green}}>
        <img src="/logo.png" alt="DealHive" style={{display:"block", width:"100%", maxWidth:185, height:"auto", objectFit:"contain"}} />
      </div>
      <div style={{flex:1, padding:"6px 10px", overflowY:"auto"}}>
        {NAV_ITEMS.filter(item => isAdmin || !item.adminOnly).map(item => {
          const active = page===item.id;
          return (
            <button key={item.id} onClick={()=>setPage(item.id)}
              className={active ? undefined : "dh-nav-item"}
              style={{
                width:"100%", padding:"8px 12px", border:"none", borderRadius:C.r2,
                cursor:"pointer", display:"flex", alignItems:"center", gap:10, marginBottom:2,
                background: active ? "rgba(255,255,255,.08)" : "transparent",
                color: active ? "#fafafa" : C.sidebarText,
                fontFamily:F, fontSize:13, fontWeight:active?600:500,
                transition:"background-color .12s, color .12s",
                letterSpacing:"-0.005em",
              }}>
              <item.Icon size={16} stroke={active?2.2:1.8}/>
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
      {daysLeft !== null && daysLeft <= TRIAL_DAYS && (
        <div style={{padding:"10px 14px"}}>
          <div style={{
            background: daysLeft<=0 ? "rgba(220,38,38,.15)" : "rgba(217,119,6,.15)",
            border: "1px solid " + (daysLeft<=0 ? "rgba(220,38,38,.3)" : "rgba(217,119,6,.3)"),
            borderRadius:C.r2, padding:"10px 12px", fontFamily:F,
          }}>
            <div style={{fontSize:11, fontWeight:700, color: daysLeft<=0 ? "#fca5a5" : "#fde68a", letterSpacing:".03em", textTransform:"uppercase"}}>
              {daysLeft<=0 ? "Trial expired" : "Free trial"}
            </div>
            {daysLeft > 0 && (
              <div style={{fontSize:13, fontWeight:600, color:"#fafafa", marginTop:2}}>
                {daysLeft} day{daysLeft===1?"":"s"} left
              </div>
            )}
          </div>
        </div>
      )}
      <div style={{
        padding:"12px 16px", borderTop:"1px solid rgba(255,255,255,.06)",
        display:"flex", alignItems:"center", gap:10,
      }}>
        <div style={{
          width:26, height:26, borderRadius:"50%", background:"rgba(255,255,255,.08)",
          display:"flex", alignItems:"center", justifyContent:"center",
          color:C.sidebarText, fontSize:11, fontWeight:600, fontFamily:F, flexShrink:0,
        }}>{(userEmail||"?")[0].toUpperCase()}</div>
        <div style={{minWidth:0, flex:1}}>
          <div style={{fontSize:11, color:C.sidebarText, fontFamily:F,
            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
            {userEmail || "—"}
          </div>
          <div style={{fontSize:10, color:"rgba(255,255,255,.3)", fontFamily:F, marginTop:1}}>v{VERSION}</div>
        </div>
      </div>
    </div>
  );
}

// -- Mobile Bottom Nav ---------------------------------------------------------
function MobileNav({page, setPage, alertCount, isAdmin}) {
  const allTabs = [
    {id:"dashboard",  Icon:I.home,           label:"Home"},
    {id:"deal",       Icon:I.search,         label:"Analyze"},
    {id:"properties", Icon:I.building,       label:"Props",   adminOnly:true},
    {id:"projects",   Icon:I.clipboardCheck, label:"Tasks",   adminOnly:true},
    {id:"deals",      Icon:I.star,           label:"Deals"},
    {id:"comps",      Icon:I.chart,          label:"Comps",   adminOnly:true},
    {id:"settings",   Icon:I.settings,       label:"More"},
  ];
  const tabs = allTabs.filter(t => isAdmin || !t.adminOnly);
  return (
    <div style={{position:"fixed", bottom:0, left:0, right:0, background:"rgba(255,255,255,.92)",
      borderTop:"1px solid "+C.border, zIndex:100,
      paddingBottom:"max(8px, env(safe-area-inset-bottom, 8px))",
      paddingLeft:"env(safe-area-inset-left, 0px)",
      paddingRight:"env(safe-area-inset-right, 0px)",
      backdropFilter:"saturate(180%) blur(10px)",
      WebkitBackdropFilter:"saturate(180%) blur(10px)"}}>
      <div style={{display:"flex", maxWidth:600, margin:"0 auto"}}>
        {tabs.map(t => {
          const active = page===t.id;
          return (
            <button key={t.id} onClick={()=>setPage(t.id)}
              style={{flex:1, minWidth:0, padding:"9px 2px 7px", border:"none", background:"none", cursor:"pointer",
                display:"flex", flexDirection:"column", alignItems:"center", gap:3,
                color:active ? C.green : C.textMuted,
                WebkitTapHighlightColor:"transparent", position:"relative",
                transition:"color .12s"}}>
              <t.Icon size={20} stroke={active?2.2:1.8}/>
              <span style={{fontSize:10, fontWeight:active?700:500, fontFamily:F, letterSpacing:"-0.005em",
                maxWidth:"100%", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{t.label}</span>
              {t.id==="dashboard" && alertCount>0 && (
                <span style={{position:"absolute", top:4, right:"calc(50% - 18px)",
                  background:C.red, color:"white", borderRadius:C.rFull,
                  fontSize:9, lineHeight:1, padding:"3px 5px", fontWeight:700, fontFamily:F,
                  border:"2px solid "+C.card}}>{alertCount}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// -- Mobile Header -------------------------------------------------------------
function MobileHeader({page, onBack, toast, onAddProperty}) {
  const showBack = page==="property";
  const titles = {
    dashboard:"Portfolio", properties:"Properties", projects:"Projects",
    deals:"Deals", deal:"Deal Analyzer", comps:"Comps",
    settings:"Settings", property:"Property"
  };
  return (
    <div style={{background:"rgba(255,255,255,.85)", borderBottom:"1px solid "+C.border,
      padding:"10px 16px",
      paddingTop:"calc(10px + env(safe-area-inset-top, 0px))",
      paddingLeft:"calc(16px + env(safe-area-inset-left, 0px))",
      paddingRight:"calc(16px + env(safe-area-inset-right, 0px))",
      position:"sticky", top:0, zIndex:200,
      backdropFilter:"saturate(180%) blur(10px)",
      WebkitBackdropFilter:"saturate(180%) blur(10px)",
      display:"flex", alignItems:"center", gap:12, minHeight:54}}>
      {showBack ? (
        <>
          <button onClick={onBack}
            style={{background:C.card, border:"1px solid "+C.border, borderRadius:C.r2,
              width:34, height:34, cursor:"pointer", color:C.text,
              display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0,
              boxShadow:C.sh1}}>
            <I.arrowLeft size={16}/>
          </button>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontWeight:600, fontSize:14, color:C.text, fontFamily:F, letterSpacing:"-0.01em",
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{titles[page]||"DealHive"}</div>
          </div>
        </>
      ) : (
        <>
          <img src="/logo.png" alt="DealHive" style={{height:36, width:"auto", maxWidth:"66%",
            objectFit:"contain", display:"block", flexShrink:0}} />
          <div style={{flex:1, minWidth:0}} />
          {page === "dashboard" && onAddProperty && (
            <button onClick={onAddProperty} {...btnStyle("primary","sm", {flexShrink:0})}>
              <I.plus size={13} stroke={2.4}/> Add Property
            </button>
          )}
        </>
      )}
      {toast && (
        <span style={{display:"inline-flex", alignItems:"center", gap:5, flexShrink:0,
          fontSize:12, color:C.greenDark, fontWeight:600, fontFamily:F,
          background:C.greenSubtle, border:"1px solid "+C.greenBorder,
          padding:"4px 9px", borderRadius:C.rFull}}>
          <I.check size={11} stroke={2.5}/>{toast}
        </span>
      )}
    </div>
  );
}

// -- Desktop Top Bar -----------------------------------------------------------
function DesktopTopBar({page, propAddress, toast, onAddProperty}) {
  const titles = {
    dashboard:"Dashboard", properties:"Properties", projects:"Projects",
    deals:"Deals", deal:"Deal Analyzer", comps:"Comps",
    settings:"Settings", property:propAddress||"Property"
  };
  return (
    <div style={{background:"#ffffff", borderBottom:"1px solid "+C.border,
      padding:"0 32px", height:56, display:"flex", alignItems:"center", justifyContent:"space-between",
      position:"sticky", top:0, zIndex:100}}>
      <div style={{fontSize:14, fontWeight:600, color:C.text, fontFamily:F, letterSpacing:"-0.01em"}}>
        {titles[page]||"DealHive"}
      </div>
      {page === "dashboard" && onAddProperty && !toast && (
        <button onClick={onAddProperty} {...btnStyle("primary","sm")}>
          <I.plus size={13} stroke={2.4}/> Add Property
        </button>
      )}
      {toast && (
        <span style={{display:"inline-flex", alignItems:"center", gap:6,
          fontSize:12, color:C.greenDark, fontWeight:600, fontFamily:F,
          background:C.greenSubtle, border:"1px solid "+C.greenBorder,
          padding:"5px 11px", borderRadius:C.rFull}}>
          <I.check size={12} stroke={2.5}/>{toast}
        </span>
      )}
    </div>
  );
}

// -- Root App ------------------------------------------------------------------
export default function App() {
  const [user,   setUser]   = useState(null);
  const [data,   setData]   = useState(null);
  // Track the URL path so the marketing-vs-auth-vs-app routing re-runs on
  // back/forward and on programmatic pushState navigations.
  const [path,   setPath]   = useState(() =>
    typeof window !== "undefined" ? window.location.pathname : "/");
  useEffect(() => {
    const onNav = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onNav);
    return () => window.removeEventListener("popstate", onNav);
  }, []);
  const [page,   setPage]   = useState("dashboard");
  // Deals-feed strategy filter lives here so the dashboard's browse-by-
  // strategy cards can set it before switching pages.
  const [dealsStrategy, setDealsStrategy] = useState("all");
  // Deal pending the save picker (choose scenario + cash/finance).
  const [savePicker, setSavePicker] = useState(null);
  const [propId, setPropId] = useState(null);
  const [showAdd,setShowAdd]= useState(false);
  const [toast,  setToast]  = useState("");
  const [daysLeft,setDL]    = useState(null);
  const [authLoading,setAL] = useState(true);
  // Set by the Deals page when the user hits "Analyze" on a deal card; the
  // DealAnalyzer consumes it on mount and clears it via onConsumeInitial so
  // a fresh visit later starts with a blank form.
  const [prefilledDeal, setPrefilledDeal] = useState(null);
  const [analyzerReturn, setAnalyzerReturn] = useState(null); // {page, dealId}
  const [reopenDealId, setReopenDealId]     = useState(null);
  const mobile = useIsMobile();

  // Always-current user for async cloud calls (avoids stale-closure tokens).
  const userRef = useRef(null);
  useEffect(() => { userRef.current = user; }, [user]);

  // Refresh the Firebase ID token so cloud sync keeps working (tokens expire
  // ~hourly). Returns the updated user (with fresh token) or null on failure.
  const refreshSession = useCallback(async () => {
    const u = userRef.current;
    if (!u || !u.refreshToken) return null;
    try {
      const t = await fbRefresh(u.refreshToken);
      const next = { ...u, idToken: t.idToken, refreshToken: t.refreshToken || u.refreshToken };
      userRef.current = next; setUser(next); saveAuth(next);
      return next;
    } catch { return null; }
  }, []);

  // Proactively refresh the token while signed in, well before it expires.
  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => { refreshSession(); }, 50 * 60 * 1000);
    return () => clearInterval(id);
  }, [user && user.localId, refreshSession]);

  // -- Stripe billing ----------------------------------------------------------
  const [billing, setBilling]         = useState(null);
  const [billingBusy, setBillingBusy] = useState(false);
  // Checkout and the customer portal both come back as a URL we send the
  // browser to. Fresh token first — these calls are token-gated server-side.
  const callBillingFn = async (name) => {
    const u = (await refreshSession()) || userRef.current;
    if (!u) throw new Error("Sign in first.");
    const r = await fetch(`${FN_BASE}/${name}`, {method: "POST",
      headers: {Authorization: `Bearer ${u.idToken}`}});
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.url) throw new Error(d.error || "Billing is unavailable right now — try again in a minute.");
    return d.url;
  };
  const startCheckout = async () => {
    if (billingBusy) return;
    setBillingBusy(true);
    try { window.location.assign(await callBillingFn("createCheckoutSession")); }
    catch (e) {
      setToast(e.message || "Could not start checkout.");
      setTimeout(() => setToast(""), 3200);
      setBillingBusy(false);
    }
  };
  const openBillingPortal = async () => {
    if (billingBusy) return;
    setBillingBusy(true);
    try { window.location.assign(await callBillingFn("createPortalSession")); }
    catch (e) {
      setToast(e.message || "Could not open billing.");
      setTimeout(() => setToast(""), 3200);
      setBillingBusy(false);
    }
  };
  // Returning from Stripe: ?billing=success|cancelled. The webhook usually
  // lands within seconds of the redirect, so poll until the tier flips.
  const billingReturnRef = useRef(
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("billing") : null);
  useEffect(() => {
    if (!user || !billingReturnRef.current) return;
    const kind = billingReturnRef.current;
    billingReturnRef.current = null;
    window.history.replaceState({}, "", "/");
    if (kind !== "success") {
      setToast("Checkout cancelled — no charge was made.");
      setTimeout(() => setToast(""), 3200);
      return;
    }
    setToast("Payment received! Activating Pro…");
    let tries = 0;
    const poll = async () => {
      const u = userRef.current;
      if (!u) return;
      const bill = await loadBilling(u.localId, u.idToken);
      if (bill && bill.tier === "pro") {
        setBilling(bill);
        setData(d => (d ? {...d, tier: "pro"} : d));
        setToast("Welcome to DealHive Pro! 🐝");
        setTimeout(() => setToast(""), 3500);
      } else if (++tries < 10) {
        setTimeout(poll, 2000);
      } else {
        setToast("Payment received — Pro activates within a minute or two.");
        setTimeout(() => setToast(""), 4000);
      }
    };
    poll();
  }, [user && user.localId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Body scroll lock — class-based. Toggling a class is far more robust
  // than mutating body.style.overflow: classList.add/remove can't get
  // stuck in a half-state under React Strict Mode, fast-clicked modal
  // sequences, or Safari quirks. The .dh-scroll-locked rule is injected
  // below alongside the rest of the global styles.
  useEffect(() => {
    if (!showAdd) return;
    lockBodyScroll();
    return unlockBodyScroll;
  }, [showAdd]);

  // Global styles
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap";
    document.head.appendChild(link);
    const style = document.createElement("style");
    style.textContent = `
      *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
      body{margin:0;font-feature-settings:"cv11","ss01","ss03";-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;-webkit-tap-highlight-color:transparent;}
      /* Scroll lock used by the AddPropertyModal. Class-based so it can't
         leave body.style.overflow stuck. */
      body.dh-scroll-locked{overflow:hidden;overscroll-behavior:none;}
      img{max-width:100%;height:auto;}
      input,select,textarea,button{font-family:inherit;}
      /* Prevent iOS from auto-zooming when focusing inputs — needs font-size >= 16px on the input. iS() already sets 16 on mobile, this is a safety net. */
      @media (max-width:767px){input,select,textarea{font-size:16px!important;}}
      input::placeholder,textarea::placeholder{color:#c2c2c9;font-style:normal;opacity:1;}
      input,select,textarea{transition:border-color .15s,box-shadow .15s;}
      input:focus,select:focus,textarea:focus{border-color:${C.green}!important;box-shadow:${C.ring}!important;}

      @keyframes dhSpin{to{transform:rotate(360deg)}}
      @keyframes dhNudge{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
      @keyframes dhExitPulse{0%{box-shadow:0 0 0 0 var(--dh-pulse, rgba(232,115,28,.4))}70%{box-shadow:0 0 0 12px transparent}100%{box-shadow:0 0 0 0 transparent}}
      .dh-exit-pulse{animation:dhExitPulse 1.15s ease-out 2 both}
      @media (prefers-reduced-motion: reduce){.dh-exit-pulse{animation:none}}
      select{appearance:none;-webkit-appearance:none;-moz-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;padding-right:38px!important;}
      input[type=range]{-webkit-appearance:none;height:6px;border-radius:3px;background:${C.bgSubtle};outline:none;border:1px solid ${C.border};}
      input[type=range]:focus{box-shadow:none!important;border-color:${C.borderHover}!important;}
      input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:${C.green};cursor:pointer;border:2px solid white;box-shadow:${C.sh2};}
      input[type=range]::-moz-range-thumb{width:18px;height:18px;border-radius:50%;background:${C.green};cursor:pointer;border:2px solid white;}
      input[type=date]{color-scheme:light;}
      button{cursor:pointer;}
      button:disabled{opacity:.55;cursor:not-allowed;}
      .dh-btn-primary:hover:not(:disabled){background:${C.greenHover}!important;border-color:${C.greenHover}!important;}
      .dh-btn-secondary:hover:not(:disabled){background:${C.bgSubtle}!important;border-color:${C.borderHover}!important;}
      .dh-btn-danger:hover:not(:disabled){background:${C.redSubtle}!important;border-color:#fca5a5!important;}
      .dh-btn-blue:hover:not(:disabled){background:${C.blueDark}!important;border-color:${C.blueDark}!important;}
      .dh-btn-dark:hover:not(:disabled){background:${C.sidebarHover}!important;border-color:${C.sidebarHover}!important;}
      .dh-btn-ghost:hover:not(:disabled){background:${C.bgSubtle}!important;color:${C.text}!important;}
      .dh-card-hover{transition:border-color .15s,box-shadow .15s,transform .15s;}
      .dh-card-hover:hover{border-color:${C.borderHover};box-shadow:${C.sh3};}
      .dh-prop-card{transition:box-shadow .15s,transform .15s,border-color .15s;}
      .dh-prop-card:hover{box-shadow:${C.sh3};}
      .dh-row{position:relative;}
      .dh-row-actions{display:inline-flex;align-items:center;gap:2px;}
      @media (hover:hover){.dh-row .dh-row-actions{opacity:0;transition:opacity .12s;}.dh-row:hover .dh-row-actions{opacity:1;}}
      .dh-row-action{background:transparent;border:none;padding:6px;border-radius:6px;cursor:pointer;color:${C.textMuted};display:inline-flex;align-items:center;justify-content:center;transition:background .12s,color .12s;}
      .dh-row-action:hover{background:${C.bgSubtle};color:${C.text};}
      /* Activity timeline: hover-reveal edit/delete on each note */
      .dh-tl-action{background:transparent;border:none;padding:4px;border-radius:4px;cursor:pointer;color:${C.textMuted};display:inline-flex;align-items:center;justify-content:center;transition:background .12s,color .12s;}
      .dh-tl-action:hover{background:${C.bgSubtle};color:${C.text};}
      @media (hover:hover){.dh-tl-item .dh-tl-actions{opacity:0;transition:opacity .12s;}.dh-tl-item:hover .dh-tl-actions{opacity:1;}}
      .dh-tl-composer:focus-within{border-color:${C.green}!important;box-shadow:${C.ring};}
      /* contentEditable rich editor: placeholder shown when empty */
      .dh-rich-editor{caret-color:${C.green};}
      .dh-rich-editor[data-empty="true"]::before{content:attr(data-placeholder);color:${C.textMuted};pointer-events:none;display:block;}
      .dh-rich-editor strong{font-weight:700;}
      .dh-rich-editor em{font-style:italic;}
      .dh-rich-editor code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:.92em;background:${C.bgSubtle};padding:1px 5px;border-radius:4px;}
      .dh-cal-nav:hover{background:${C.bgSubtle}!important;color:${C.text}!important;}
      .dh-cal-day:hover{background:${C.bgSubtle};}
      .dh-cal-day[aria-pressed="true"]:hover{background:${C.greenHover}!important;}
      .dh-prop-subheader:hover{background:${C.bgSubtle}!important;}
      @keyframes dh-pulse{0%,100%{opacity:1;}50%{opacity:.35;}}
      .dh-pulse{animation:dh-pulse 2s ease-in-out infinite;}
      .dh-nav-item{transition:background-color .12s,color .12s;}
      .dh-nav-item:hover{background:rgba(255,255,255,.06);color:#fafafa;}
      .dh-tab-row::-webkit-scrollbar{display:none;}
      .dh-chip-row{scrollbar-width:none;}
      .dh-chip-row::-webkit-scrollbar{display:none;}
      ::-webkit-scrollbar{width:10px;height:10px;}
      ::-webkit-scrollbar-track{background:transparent;}
      ::-webkit-scrollbar-thumb{background:${C.border};border-radius:6px;border:2px solid ${C.bg};}
      ::-webkit-scrollbar-thumb:hover{background:${C.borderHover};}
      a{color:inherit;}
      h1,h2,h3,h4,h5,h6{letter-spacing:-0.02em;font-feature-settings:"cv11","ss01","ss03";}
    `;
    document.head.appendChild(style);
    const saved = loadAuth();
    if (saved) handleAuth(saved, false, true); else setAL(false);
  }, []);

  const handleAuth = async (u, isNew=false, silent=false) => {
    // A restored session's stored token is usually expired — refresh it first
    // so we read the cloud copy (synced from other devices), not local-only.
    if (silent && u.refreshToken) {
      try { const t = await fbRefresh(u.refreshToken); u = { ...u, idToken: t.idToken, refreshToken: t.refreshToken || u.refreshToken }; } catch {}
    }
    setUser(u); saveAuth(u); userRef.current = u;
    // Land authenticated users on a clean URL — they came from /login or
    // /signup, but the app itself doesn't care about path-based routing.
    if (typeof window !== "undefined" && (window.location.pathname === "/login" || window.location.pathname === "/signup")) {
      window.history.replaceState({}, "", "/");
      setPath("/");
    }
    let meta = await loadMeta(u.localId, u.idToken);
    if (!meta || isNew) {
      meta = {createdAt:new Date().toISOString(), trialStart:new Date().toISOString()};
      await saveMeta(u.localId, u.idToken, meta);
    }
    // No trial in the business model — Free is free forever, Pro is $29.99/mo
    // via Stripe. daysLeft stays null, which keeps every trial banner hidden.
    const saved = await loadData(u.localId, u.idToken);
    const bill  = await loadBilling(u.localId, u.idToken);
    setBilling(bill);
    const base  = saved || {...SEED};
    // Tier authority: billing/{uid}, written by the Stripe webhook. Members
    // without a billing record are Free — this also clears "pro" flags left
    // behind by the pre-Stripe instant-upgrade toggle. Admin accounts keep
    // their stored tier (dev toggle).
    const adminUser = (base.role === "admin") || u.email === "harut@ymail.com";
    const tier = bill && bill.tier ? bill.tier : adminUser ? (base.tier || "free") : "free";
    setData({...base, tier});
    setAL(false);
    if (!silent) { setToast("Welcome to DealHive! 🐝"); setTimeout(()=>setToast(""), 3000); }
  };

  const handleSignOut = () => {
    clearAuth(); setUser(null); setData(null); setPage("dashboard"); setPropId(null);
    if (typeof window !== "undefined" && window.location.pathname !== "/") {
      window.history.replaceState({}, "", "/"); setPath("/");
    }
  };

  // Save to the cloud; if it fails (likely an expired token), refresh and retry
  // once so the change still syncs instead of going local-only.
  const [syncWarn, setSyncWarn] = useState(false);
  const saveCloud = useCallback(async (next) => {
    const u = userRef.current;
    if (!u) return;
    const ok = await saveData(u.localId, u.idToken, next);
    if (ok) { setSyncWarn(false); return; }
    const nu = await refreshSession();
    const ok2 = nu ? await saveData(nu.localId, nu.idToken, next) : false;
    setSyncWarn(!ok2);
  }, [refreshSession]);

  const persist = useCallback((next) => {
    setData(next);
    saveCloud(next);
    setToast("Saved OK"); setTimeout(()=>setToast(""), 1600);
  }, [saveCloud]);

  // Quiet persist — used for cache/usage bookkeeping so it doesn't flash a
  // "Saved OK" toast on every API lookup.
  const persistQuiet = useCallback((next) => {
    setData(next);
    saveCloud(next);
  }, [saveCloud]);

  // Central cached + capped lookup. `fetcher` runs only on a cache miss, and a
  // miss counts against the monthly cap (unless count:false). Throws a CAP error
  // when the cap is hit so the caller can show a friendly message.
  const apiLookup = useCallback(async (key, fetcher, { count = true } = {}) => {
    const cache = (data && data.apiCache) || {};
    const hit = cache[key];
    if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.payload;

    const month = monthKey();
    const used = (data && data.usage && data.usage.month === month) ? (data.usage.count || 0) : 0;
    if (count && used >= LOOKUP_CAP) { const e = new Error("LOOKUP_CAP"); e.code = "CAP"; throw e; }

    const payload = await fetcher();

    let entries = Object.entries({ ...cache, [key]: { ts: Date.now(), payload } });
    if (entries.length > CACHE_MAX) {
      entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
      entries = entries.slice(0, CACHE_MAX);
    }
    persistQuiet({
      ...data,
      apiCache: Object.fromEntries(entries),
      usage: count ? { month, count: used + 1 } : (data.usage || null),
    });
    return payload;
  }, [data, persistQuiet]);

  // Branded boot screen — shown while restoring a session AND in the moment
  // between a successful login and the account data arriving (previously that
  // gap flashed the marketing homepage).
  const bootScreen = (
    <div style={{minHeight:"100vh", background:C.bg,
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:18}}>
      <style>{`
        @keyframes dhBootPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.75;transform:scale(.97)}}
        @keyframes dhBootSpin{to{transform:rotate(360deg)}}
      `}</style>
      <img src="/logo.png" alt="DealHive"
        style={{height:52, width:"auto", maxWidth:"70%", objectFit:"contain",
          animation:"dhBootPulse 1.6s ease-in-out infinite"}} />
      <div style={{width:22, height:22, borderRadius:"50%",
        border:"2.5px solid "+C.border, borderTopColor:C.green,
        animation:"dhBootSpin .8s linear infinite"}}/>
    </div>
  );
  if (authLoading) return bootScreen;
  if (user && !data) return bootScreen;

  // Public surface: multi-page marketing site + auth at /login | /signup.
  // Unknown unauth paths fall back to the landing home so stale bookmarks
  // still land somewhere sensible. Legal pages stay reachable even when
  // signed in (Settings links + App Store review both need that).
  const navigate = p => { window.history.pushState({}, "", p); setPath(p); window.scrollTo(0, 0); };
  const marketingProps = {
    page: path,
    navigate,
    onSignIn: () => navigate("/login"),
    onSignUp: () => navigate("/signup"),
  };
  if (!user || !data) {
    const onAuthRoute = path === "/login" || path === "/signup";
    if (onAuthRoute) return (
      <MarketingChrome navigate={navigate}
        onSignIn={() => navigate("/login")} onSignUp={() => navigate("/signup")}>
        <AuthPage onAuth={handleAuth} />
      </MarketingChrome>
    );
    return <Landing {...marketingProps} />;
  }
  if (path === "/privacy" || path === "/terms") {
    return <Landing {...marketingProps} onSignIn={() => navigate("/")} onSignUp={() => navigate("/")} />;
  }

  // App handlers
  const updateProp = p  => persist({...data, properties:data.properties.map(x=>x.id===p.id?p:x)});
  const addProp    = p  => { persist({...data,properties:[...data.properties,p]}); setShowAdd(false); setPropId(p.id); setPage("property"); };
  const delProp    = id => { persist({...data,properties:data.properties.filter(p=>p.id!==id)}); setPropId(null); setPage("properties"); };
  const saveDeals  = ds => persist({...data, deals:ds});
  const saveRCKey  = k  => persist({...data, rentcastKey:k});

  const moveDealToPortfolio = deal => {
    const p = newProp({
      ...deal, id:"p"+Date.now(),
      purchasePrice: deal.purchasePrice||0,
      repairCosts:   deal.repairCosts||0,
      closingCosts:  deal.closingCosts||DEFAULT_CLOSING,
      projects:[], occupied:false, tenantStatus:"Vacant"
    });
    persist({...data, properties:[...data.properties,p], deals:(data.deals||[]).filter(d=>d.id!==deal.id)});
    setPropId(p.id); setPage("property");
    setToast("Deal added to My Properties! OK"); setTimeout(()=>setToast(""),2000);
  };

  // Deals page / Deal View → Analyzer: prefill and remember where the user
  // came from so the analyzer's back button returns there (and reopens the
  // deal view they were reading).
  const analyzeDealFromMarket = deal => {
    setAnalyzerReturn({page, dealId: deal.id || null});
    setPrefilledDeal(dealToProForma(deal));
    setPage("deal");
  };
  // Admin save (creates a Property in the portfolio). Regular members get
  // saveDealToWatchlist instead, just below.
  const saveDealToPortfolio = deal => {
    const p = newProp({
      ...dealToProForma(deal), id:"p"+Date.now(),
      projects:[], occupied:false, tenantStatus:"Vacant",
    });
    persist({...data, properties:[...data.properties, p]});
    setPropId(p.id); setPage("property");
    setToast("Saved to My Properties"); setTimeout(()=>setToast(""), 2000);
  };
  // Regular-member save: add to data.savedDeals so it shows up on their
  // Dashboard. Keyed by deal.id so re-saving the same deal is a no-op.
  // Upsert: saving a deal that's already on the watchlist (same id, or same
  // address in the same city) updates it in place — new numbers, new
  // scenario, new financing — instead of rejecting. Returns "created" |
  // "updated" (both truthy) so callers can phrase their confirmation.
  const saveDealToWatchlist = (deal, scenario, financing) => {
    const existing = data.savedDeals || [];
    const label = (STRATEGY_LABELS[scenario] || STRATEGY_LABELS.buyhold).label;
    const fin = financing === "owned" ? "already owned" : financing === "cash" ? "all cash" : "financed";
    const match = existing.find(x => x.id === deal.id ||
      (deal.address && x.address === deal.address && x.city === deal.city));
    if (!match && (data.tier||"free") !== "pro" && existing.length >= 15) {
      setToast("Free plan holds 15 saved deals — upgrade to Pro for unlimited");
      setTimeout(()=>setToast(""), 2600);
      return "limit";
    }
    if (match) {
      const updated = {...match, ...deal, id: match.id,
        savedAt: match.savedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(), scenario, financing};
      persist({...data, savedDeals: existing.map(x => x.id === match.id ? updated : x)});
      setToast(`Updated: ${label} (${fin})`);
      setTimeout(()=>setToast(""), 2200);
      return "updated";
    }
    const saved = {...deal, savedAt: new Date().toISOString(), scenario, financing};
    persist({...data, savedDeals: [...existing, saved]});
    setToast(`Saved to ${label} (${fin})`);
    setTimeout(()=>setToast(""), 2200);
    return "created";
  };
  const removeFromWatchlist = dealOrId => {
    const id = typeof dealOrId === "string" ? dealOrId : dealOrId.id;
    persist({...data, savedDeals: (data.savedDeals || []).filter(d => d.id !== id)});
    setToast("Removed from saved deals"); setTimeout(()=>setToast(""), 2000);
  };
  // Patch one saved deal in place (user photo lists etc.) and sync.
  const patchSavedDeal = (id, patch) => {
    persist({...data, savedDeals: (data.savedDeals || []).map(d => d.id === id ? {...d, ...patch} : d)});
  };
  // Compress and upload the user's own deal photos; returns their URLs.
  const uploadDealPhotos = async (deal, files) => {
    const u = (await refreshSession()) || userRef.current;
    if (!u) throw new Error("Sign in first.");
    const urls = [];
    for (const f of files) {
      const blob = await compressImage(f);
      const path = `dealPhotos/${u.localId}/${deal.id}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
      urls.push(await fbStorageUpload(path, blob, u.idToken));
    }
    return urls;
  };
  // The actual save handler the Deals page calls — admin gets portfolio,
  // everyone else picks a scenario + financing in the save sheet first.
  const saveDealFromMarket = deal => {
    if (isAdmin) saveDealToPortfolio(deal);
    else         setSavePicker({deal, suggested: null});
  };
  // Admin/dev path: flips the tier flag directly (no Stripe). Member tier is
  // set server-side by the Stripe webhook and folded in at sign-in.
  const setTier = (tier) => {
    persist({...data, tier});
    setToast(tier === "pro" ? "Welcome to DealHive Pro!" : "Switched to Free");
    setTimeout(()=>setToast(""), 2500);
  };
  // Members go through Stripe: checkout to upgrade, the billing portal to
  // manage or cancel. The admin account keeps the instant toggle for testing.
  const handleUpgrade   = () => { if (isAdmin) setTier("pro");  else startCheckout(); };
  const handleDowngrade = () => { if (isAdmin) setTier("free"); else openBillingPortal(); };

  // Admin gate. data.role is the canonical signal (set via Firebase console
  // to "admin" on accounts that should get the full portfolio app). The email
  // fallback exists so the original owner account stays admin without needing
  // a manual Firebase edit.
  const isAdmin = (data.role === "admin") || user.email === "harut@ymail.com";

  const alerts     = (data.properties||[]).filter(p => {
    const d = dU(p.leaseEnd);
    return p.tenantStatus==="Late" || (d!=null && d<=60 && d>=0);
  }).length;
  const activeProp = (data.properties||[]).find(p => p.id===propId);
  const showProp   = !!propId && !!activeProp && isAdmin; // never show property view to non-admins
  const effPage    = showProp ? "property" : page;

  const sharedProps = {
    renoRates: data.renoRates || SEED.renoRates,
    mobile,
    apiLookup,
    rentcastKey: data.rentcastKey || "",
    // Auth for property-data calls: personal key when present (legacy),
    // else the session token for the server proxy — every signed-in user.
    rcAuth: {key: data.rentcastKey || "", token: user.idToken},
    tier: data.tier || "free",
  };

  const dealAnalyzerProps = {
    deals: data.deals || [],
    onSave: saveDeals,
    // Members file analyses onto their home watchlist. No picker sheet here:
    // the analyzer already knows the exit (Save button names it) and the
    // purchase method, so the save is one tap. The Deals-page save keeps its
    // sheet since market cards carry no user choice yet.
    onSaveToWatchlist: isAdmin ? null : (pf, suggested) => {
      const mm = calc(pf);
      const isCash = pf.chosenStrategy === "cash";
      const res = saveDealToWatchlist(
        {...proFormaToFeedDeal(pf), chosenStrategy: pf.chosenStrategy,
          // Snapshot of the analyzer's own numbers so the home card shows
          // exactly what the user saw at save time — not the feed
          // classifier's re-derivation with different assumptions.
          analysis: {
            method:       pf.alreadyOwned ? "owned" : isCash ? "cash" : "finance",
            oop:          Math.round(isCash ? mm.cashOOP : mm.finOOP),
            cashFlow:     Math.round(isCash ? mm.cashCF  : mm.finCF),
            coc:          isCash ? mm.cashCoC : mm.finCoC,
            capRate:      isCash ? mm.cashCap : mm.finCap,
            flipProfit:   Math.round(isCash ? mm.flipProfit : mm.finFlipProfit),
            flipROI:      isCash ? mm.flipROI : mm.finFlipROI,
            brrrrCF:      Math.round(mm.brrrCF),
            brrrrCashOut: Math.round(mm.brrrCashOut),
            brrrrNetCash: Math.round(isCash && !pf.alreadyOwned ? mm.brrrCashNet : mm.brrrNetCash),
            brrrrAllIn:   Math.round(mm.brrrAllIn),
            arv:          pf.homeValueHigh || pf.flipSalePrice || 0,
            // Projection inputs captured at save time.
            expMo:        Math.round(mm.exp),
            mtgMo:        Math.round(isCash ? (pf.alreadyOwned ? (pf.ownedLoanPayment||0) : 0) : mm.mtg),
            loanAmt:      Math.round(isCash ? (pf.alreadyOwned ? (pf.ownedLoanBalance||0) : 0) : mm.loan),
            loanRate:     pf.alreadyOwned ? 7
              : Array.isArray(pf.loans) && pf.loans.length && mm.loan > 0
                ? Math.round(mm.loanBreakdown.reduce((s, b) => s + b.amount * (b.loan.rate ?? 12), 0) / mm.loan * 100) / 100
                : (pf.interestRate || 7.5),
          }},
        suggested || "buyhold",
        pf.alreadyOwned ? "owned" : isCash ? "cash" : "finance");
      // A professional save takes you to where the deal now lives.
      if (res === "created" || res === "updated") setPage("dashboard");
    },
    onMoveToPortfolio: moveDealToPortfolio,
    onUpgrade: handleUpgrade,
    initial: prefilledDeal,
    onConsumeInitial: () => setPrefilledDeal(null),
    backLabel: analyzerReturn && analyzerReturn.page === "dashboard" ? "Back to saved deal" : "Back to deals",
    onBackToDeals: () => {
      const r = analyzerReturn;
      setAnalyzerReturn(null);
      if (r && r.page === "dashboard") {
        if (r.dealId) setReopenDealId(r.dealId);
        setPage("dashboard");
      } else {
        setPage("deals");
      }
    },
    ...sharedProps,
  };

  // Mobile layout
  if (mobile) return (
    <div style={{fontFamily:F, background:C.bg, minHeight:"100vh", width:"100%", maxWidth:600, margin:"0 auto", overflowX:"clip"}}>
      <AppHexBg/>
      <div style={{position:"relative", zIndex:1}}>
      <MobileHeader page={effPage} onBack={()=>setPropId(null)} toast={toast} daysLeft={daysLeft}
        onAddProperty={()=>setPage("deal")} />
      <TrialBanner daysLeft={daysLeft} />
      {syncWarn && (
        <div style={{background:C.amberSubtle, borderBottom:"1px solid "+C.amberBorder,
          padding:"8px 16px", display:"flex", alignItems:"center", gap:8,
          fontSize:12.5, color:C.amberDark, fontFamily:F}}>
          <I.alert size={14}/> Changes are saving to this device only right now — they'll sync automatically once your connection is back.
        </div>
      )}
      <ErrorBoundary>
        {showProp ? (
          <PropertyDetail prop={activeProp} onBack={()=>setPropId(null)}
            onChange={updateProp} onDelete={delProp} llcs={data.llcs||[]} {...sharedProps} />
        ) : page==="dashboard" ? (
          isAdmin
            ? <Dashboard properties={data.properties||[]} onSelect={id=>setPropId(id)} onAdd={()=>setShowAdd(true)} mobile={mobile} />
            : <SavedDealsDashboard savedDeals={data.savedDeals||[]} tier={data.tier||"free"}
                onUpgrade={handleUpgrade} onAnalyze={analyzeDealFromMarket}
                onRemove={removeFromWatchlist} onBrowse={()=>{setDealsStrategy("all");setPage("deals");}}
                onBrowseStrategy={st=>{setDealsStrategy(st);setPage("deals");}}
                onAnalyzeNew={()=>setPage("deal")}
                apiLookup={apiLookup} rcAuth={sharedProps.rcAuth}
                onUploadPhotos={uploadDealPhotos} onPatchDeal={patchSavedDeal}
                openDealId={reopenDealId} onConsumeOpenDeal={()=>setReopenDealId(null)} mobile={mobile} />
        ) : page==="properties" && isAdmin ? (
          <MyProperties properties={data.properties||[]} onSelect={id=>setPropId(id)} onAdd={()=>setShowAdd(true)} onDelete={delProp} mobile={mobile} />
        ) : page==="projects" && isAdmin ? (
          <ProjectsPage properties={data.properties||[]} onUpdateProperty={updateProp} mobile={mobile} />
        ) : page==="deals" ? (
          <DealsPage tier={data.tier||"free"} onUpgrade={handleUpgrade}
            onAnalyzeDeal={analyzeDealFromMarket} onSaveDeal={saveDealFromMarket}
            strategy={dealsStrategy} onStrategyChange={setDealsStrategy}
            token={user.idToken} locked={!isAdmin && (data.tier||"free") !== "pro"} mobile={mobile} />
        ) : page==="deal" ? (
          <DealAnalyzer {...dealAnalyzerProps} />
        ) : page==="comps" ? (
          <LeaseComps rentcastKey={data.rentcastKey||""} onSaveKey={saveRCKey} mobile={mobile} apiLookup={apiLookup} />
        ) : page==="settings" ? (
          <SettingsPage onSignOut={handleSignOut} mobile={mobile} userEmail={user.email}
            tier={data.tier||"free"} onUpgrade={handleUpgrade} onDowngrade={handleDowngrade}
            billing={billing} billingBusy={billingBusy} isAdmin={isAdmin} />
        ) : (
          // Fallback for non-admins who somehow land on an admin-only page —
          // bounce them to their dashboard.
          isAdmin
            ? null
            : <SavedDealsDashboard savedDeals={data.savedDeals||[]} tier={data.tier||"free"}
                onUpgrade={handleUpgrade} onAnalyze={analyzeDealFromMarket}
                onRemove={removeFromWatchlist} onBrowse={()=>{setDealsStrategy("all");setPage("deals");}}
                onBrowseStrategy={st=>{setDealsStrategy(st);setPage("deals");}}
                onAnalyzeNew={()=>setPage("deal")}
                apiLookup={apiLookup} rcAuth={sharedProps.rcAuth}
                onUploadPhotos={uploadDealPhotos} onPatchDeal={patchSavedDeal}
                openDealId={reopenDealId} onConsumeOpenDeal={()=>setReopenDealId(null)} mobile={mobile} />
        )}
      </ErrorBoundary>
      <MobileNav page={showProp?"dashboard":page} setPage={p=>{setPage(p);setPropId(null);}} alertCount={alerts} isAdmin={isAdmin} />
      {showAdd && <AddPropertyModal llcs={data.llcs||[]} onAdd={addProp} onClose={()=>setShowAdd(false)} {...sharedProps} />}
      {savePicker && (
        <SaveDealSheet deal={savePicker.deal} suggestedOverride={savePicker.suggested} mobile={mobile}
          onCancel={()=>setSavePicker(null)}
          onConfirm={(scenario, financing)=>saveDealToWatchlist(savePicker.deal, scenario, financing)} />
      )}
      </div>
    </div>
  );

  // Desktop layout
  return (
    <div style={{fontFamily:F, background:C.bg, minHeight:"100vh", display:"flex"}}>
      <AppHexBg/>
      <DesktopSidebar page={showProp?"properties":page} setPage={p=>{setPage(p);setPropId(null);}} daysLeft={daysLeft} userEmail={user.email} isAdmin={isAdmin} />
      <div style={{marginLeft:230, flex:1, minWidth:0, position:"relative", zIndex:1}}>
        <DesktopTopBar page={effPage} propAddress={activeProp?.address} toast={toast}
          onAddProperty={()=>setPage("deal")} />
        <TrialBanner daysLeft={daysLeft} />
      {syncWarn && (
        <div style={{background:C.amberSubtle, borderBottom:"1px solid "+C.amberBorder,
          padding:"8px 16px", display:"flex", alignItems:"center", gap:8,
          fontSize:12.5, color:C.amberDark, fontFamily:F}}>
          <I.alert size={14}/> Changes are saving to this device only right now — they'll sync automatically once your connection is back.
        </div>
      )}
        <div style={{maxWidth:1200, margin:"0 auto"}}>
          <ErrorBoundary>
            {showProp ? (
              <PropertyDetail prop={activeProp} onBack={()=>setPropId(null)}
                onChange={updateProp} onDelete={delProp} llcs={data.llcs||[]} {...sharedProps} />
            ) : page==="dashboard" ? (
              isAdmin
                ? <Dashboard properties={data.properties||[]} onSelect={id=>setPropId(id)} onAdd={()=>setShowAdd(true)} mobile={mobile} />
                : <SavedDealsDashboard savedDeals={data.savedDeals||[]} tier={data.tier||"free"}
                    onUpgrade={handleUpgrade} onAnalyze={analyzeDealFromMarket}
                    onRemove={removeFromWatchlist} onBrowse={()=>{setDealsStrategy("all");setPage("deals");}}
                    onBrowseStrategy={st=>{setDealsStrategy(st);setPage("deals");}}
                onAnalyzeNew={()=>setPage("deal")}
                apiLookup={apiLookup} rcAuth={sharedProps.rcAuth}
                onUploadPhotos={uploadDealPhotos} onPatchDeal={patchSavedDeal}
                openDealId={reopenDealId} onConsumeOpenDeal={()=>setReopenDealId(null)} mobile={mobile} />
            ) : page==="properties" && isAdmin ? (
              <MyProperties properties={data.properties||[]} onSelect={id=>setPropId(id)} onAdd={()=>setShowAdd(true)} onDelete={delProp} mobile={mobile} />
            ) : page==="projects" && isAdmin ? (
              <ProjectsPage properties={data.properties||[]} onUpdateProperty={updateProp} mobile={mobile} />
            ) : page==="deals" ? (
              <DealsPage tier={data.tier||"free"} onUpgrade={handleUpgrade}
                onAnalyzeDeal={analyzeDealFromMarket} onSaveDeal={saveDealFromMarket}
                strategy={dealsStrategy} onStrategyChange={setDealsStrategy}
                token={user.idToken} locked={!isAdmin && (data.tier||"free") !== "pro"} mobile={mobile} />
            ) : page==="deal" ? (
              <DealAnalyzer {...dealAnalyzerProps} />
            ) : page==="comps" ? (
              <LeaseComps rentcastKey={data.rentcastKey||""} onSaveKey={saveRCKey} mobile={mobile} apiLookup={apiLookup} />
            ) : page==="settings" ? (
              <SettingsPage onSignOut={handleSignOut} mobile={mobile} userEmail={user.email}
                tier={data.tier||"free"} onUpgrade={handleUpgrade} onDowngrade={handleDowngrade}
            billing={billing} billingBusy={billingBusy} isAdmin={isAdmin} />
            ) : null}
          </ErrorBoundary>
        </div>
      </div>
      {showAdd && <AddPropertyModal llcs={data.llcs||[]} onAdd={addProp} onClose={()=>setShowAdd(false)} {...sharedProps} />}
      {savePicker && (
        <SaveDealSheet deal={savePicker.deal} suggestedOverride={savePicker.suggested} mobile={mobile}
          onCancel={()=>setSavePicker(null)}
          onConfirm={(scenario, financing)=>saveDealToWatchlist(savePicker.deal, scenario, financing)} />
      )}
    </div>
  );
}
