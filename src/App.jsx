import React, { useState, useEffect, useRef, useCallback } from "react";

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
const TRIAL_DAYS     = 7;
const VERSION        = "1.0.0";
const DEFAULT_CLOSING = 10895;

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
const fbResetPassword = async (email) => {
  const r = await fetch(`${FB_AUTH_URL}/accounts:sendOobCode?key=${FB_API_KEY}`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({requestType:"PASSWORD_RESET", email})
  });
  const d = await r.json(); if(d.error) throw new Error(d.error.message); return d;
};

// -- Firebase DB ---------------------------------------------------------------
const dbPath   = uid => `${FB_DB_URL}/users/${uid}/data.json`;
const metaPath = uid => `${FB_DB_URL}/users/${uid}/meta.json`;

const saveData = async (uid, token, d) => {
  try {
    await fetch(`${dbPath(uid)}?auth=${token}`, {
      method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(d)
    });
  } catch { try { localStorage.setItem(`dh_${uid}`, JSON.stringify(d)); } catch {} }
};
const loadData = async (uid, token) => {
  try {
    const r = await fetch(`${dbPath(uid)}?auth=${token}`);
    if(r.ok) { const d = await r.json(); if(d?.properties) return d; }
  } catch {}
  try { const r = localStorage.getItem(`dh_${uid}`); if(r) return JSON.parse(r); } catch {}
  return null;
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
  renoRates:{light:7, medium:13, full:45}, properties:[]
};

// -- Finance -------------------------------------------------------------------
const monthlyPI = (principal, rate, years=30) => {
  if (!principal || !rate) return 0;
  const r = rate/100/12, n = years*12;
  return principal * (r * Math.pow(1+r,n)) / (Math.pow(1+r,n)-1);
};

const calc = (p) => {
  const vacancyFactor = 1 - ((p.vacancyRate||0)/100);
  const effectiveRent = (p.rentAmount||0) * vacancyFactor;
  const exp  = (p.expPropTax||0)+(p.expUtilities||0)+(p.expManagement||0)+(p.expInsurance||0);
  const noi  = effectiveRent - exp;
  const cashOOP  = (p.purchasePrice||0)+(p.repairCosts||0);
  const cashCF   = effectiveRent - exp;
  const cashCoC  = cashOOP>0 ? (cashCF*12/cashOOP)*100 : 0;
  const cashCap  = cashOOP>0 ? (noi*12/cashOOP)*100 : 0;
  const down     = (p.purchasePrice||0) * (p.downPaymentPct||20)/100;
  const loan     = (p.purchasePrice||0) - down;
  const mtg      = monthlyPI(loan, p.interestRate||7.5);
  const cc       = p.closingCosts != null ? p.closingCosts : DEFAULT_CLOSING;
  const finOOP   = down + (p.repairCosts||0) + cc;
  const finCF    = effectiveRent - exp - mtg;
  const finCoC   = finOOP>0 ? (finCF*12/finOOP)*100 : 0;
  const finCap   = (p.purchasePrice||0)>0 ? (noi*12/(p.purchasePrice||0))*100 : 0;
  const payoff   = (finCF>0 && finOOP>0) ? finOOP/(finCF*12) : 0;
  const brrrCashOut = p.brrrCashOut || Math.round((p.homeValueMedian||0)*0.8);
  const brrrMtg  = monthlyPI(brrrCashOut, p.interestRate||7.5);
  const brrrCF   = effectiveRent - exp - brrrMtg;
  const agentFee = (p.flipSalePrice||0) * (p.agentFeePct||6)/100;
  const flipProfit = (p.flipSalePrice||0) - cashOOP - agentFee;
  const flipROI  = cashOOP>0 ? (flipProfit/cashOOP)*100 : 0;
  const s = p.chosenStrategy || "finance";
  return {
    exp, noi, effectiveRent, cashOOP, cashCF, cashCoC, cashCap,
    down, loan, mtg, cc, finOOP, finCF, finCoC, finCap, payoff,
    brrrCashOut, brrrMtg, brrrCF, agentFee, flipProfit, flipROI,
    chosenCF:  s==="cash" ? cashCF  : finCF,
    chosenCoC: s==="cash" ? cashCoC : finCoC,
    chosenCap: s==="cash" ? cashCap : finCap,
    chosenOOP: s==="cash" ? cashOOP : finOOP,
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
const svUrl   = (lat,lng,w=800,h=400) => "https://maps.googleapis.com/maps/api/streetview?size="+w+"x"+h+"&location="+lat+","+lng+"&fov=90&pitch=0&key="+GOOGLE_API_KEY;

const newProp = (base={}) => ({
  id:"p"+Date.now(), address:"", city:"", state:"", zip:"", lat:null, lng:null,
  llc:"", type:"", beds:0, baths:0, sqft:0, yearBuilt:0,
  purchasePrice:0, repairCosts:0, rentAmount:0, taxValue:0, parcelId:"",
  homeValueLow:0, homeValueMedian:0, homeValueHigh:0,
  repairLight:0, repairMedium:0, repairFull:0,
  downPaymentPct:20, interestRate:7.5, closingCosts:DEFAULT_CLOSING,
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
  repairLight:0, repairMedium:0, repairFull:0,
  purchasePrice:0, repairCosts:0, rentAmount:0,
  rentEstimate:0, rentEstLow:0, rentEstHigh:0,
  downPaymentPct:20, interestRate:7.5, closingCosts:DEFAULT_CLOSING,
  expPropTax:0, expUtilities:0, expManagement:0, expInsurance:0,
  vacancyRate:5,
  brrrCashOut:0, flipSalePrice:0, agentFeePct:6,
  chosenStrategy:"finance", notes:"", savedAt:""
});

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
const rentcastFetch = async (addr, city, state, zip, key) => {
  const full = [addr, [city, state].filter(Boolean).join(" "), zip].filter(Boolean).join(", ");
  const q = encodeURIComponent(full);
  const h = {"X-Api-Key": key};
  const out = {};
  try { const r=await fetch(`${RC_BASE}/properties?address=${q}`, {headers:h}); const d=await r.json(); if(Array.isArray(d) && d[0]) out.property=d[0]; } catch {}
  try { const r=await fetch(`${RC_BASE}/avm/value?address=${q}`, {headers:h}); const d=await r.json(); if(d && (d.price || d.priceRangeLow)) out.value=d; } catch {}
  try { const r=await fetch(`${RC_BASE}/avm/rent/long-term?address=${q}`, {headers:h}); const d=await r.json(); if(d && d.rent) out.rent=d; } catch {}
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
  const taxVal = assess.value || prev.taxValue || 0;
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
    yearBuilt: p.yearBuilt    || prev.yearBuilt,
    taxValue:  taxVal,
    parcelId:  p.assessorID   || prev.parcelId,
    lat:       p.latitude  || val.latitude  || rent.latitude  || prev.lat,
    lng:       p.longitude || val.longitude || rent.longitude || prev.lng,
    type:      p.propertyType || prev.type,
    expPropTax: annual ? Math.round(annual/12) : (taxVal ? Math.round(taxVal*0.024/12) : prev.expPropTax),
    homeValueMedian: med, homeValueLow: lo, homeValueHigh: hi,
    flipSalePrice: hi || prev.flipSalePrice,
    brrrCashOut:   med ? Math.round(med * 0.8) : prev.brrrCashOut,
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
  chevronDown: p => <IconSvg {...p} d="M6 9l6 6 6-6"/>,
  trash:       p => <IconSvg {...p} d={<g><path d="M3 6h18"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></g>}/>,
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

function SectionBlock({title, color=C.green, children, right, collapsible=false, defaultOpen=true}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card style={{marginBottom:14, padding:0}}>
      <div style={{padding:"14px 16px", display:"flex", justifyContent:"space-between", alignItems:"center",
        borderBottom: open ? "1px solid "+C.border : "none",
        cursor: collapsible ? "pointer" : "default"}}
        onClick={collapsible ? ()=>setOpen(o=>!o) : undefined}>
        <div style={{display:"flex", alignItems:"center", gap:10}}>
          <div style={{width:3, height:14, background:color, borderRadius:2}} />
          <span style={{color:C.text, fontWeight:600, fontSize:14, fontFamily:F, letterSpacing:"-0.01em"}}>{title}</span>
        </div>
        <div style={{display:"flex", gap:8, alignItems:"center"}}>
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
function InputField({label, val, set, type="number", suf, pre, note, mobile=false}) {
  const isNum = type === "number";
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState("");

  // While editing a number field we show a raw, freely-editable string (so it
  // can be cleared with backspace); when idle we show it with thousands commas.
  const display = !isNum
    ? (val ?? "")
    : focused
      ? draft
      : (val === "" || val == null ? "" : Number(val).toLocaleString());

  const onFocus = () => {
    if (isNum) setDraft(val && Number(val) !== 0 ? String(val) : "");
    setFocused(true);
  };
  const onChange = e => {
    if (!isNum) { set(e.target.value); return; }
    const raw = e.target.value.replace(/[^0-9.]/g, "");
    setDraft(raw);
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
        <input type={isNum ? "text" : type} value={display}
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

function StreetViewImg({lat, lng, address, height=200}) {
  if (!lat || !lng) return null;
  return (
    <div style={{position:"relative", borderRadius:C.r4, overflow:"hidden", marginBottom:16,
      border:"1px solid "+C.border, boxShadow:C.sh1}}>
      <img src={svUrl(lat,lng,900,height*2)} alt="Street View"
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

  const linkBtn = {
    background:"none", border:"none", padding:0, color:C.green, fontWeight:600,
    cursor:"pointer", fontFamily:F, fontSize:13, letterSpacing:"-0.005em",
  };
  return (
    <div style={{
      minHeight:"100vh", background:C.bg, padding:20,
      display:"flex", alignItems:"center", justifyContent:"center",
      backgroundImage:`radial-gradient(circle at 100% 0%, ${C.greenSubtle} 0%, transparent 45%), radial-gradient(circle at 0% 100%, ${C.bgSubtle} 0%, transparent 50%)`,
    }}>
      <div style={{width:"100%", maxWidth:400}}>
        <div style={{textAlign:"center", marginBottom:28}}>
          <img src="/logo.png" alt="DealHive" style={{height:48, width:"auto", maxWidth:"82%", objectFit:"contain", marginBottom:10}} />
          <div style={{fontSize:13, color:C.textSub, fontFamily:F}}>Real estate investing, organized.</div>
        </div>
        <Card style={{padding:30}}>
          <h2 style={{margin:"0 0 6px", fontSize:20, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.02em"}}>
            {mode==="signin" ? "Welcome back" : mode==="signup" ? "Start your free trial" : "Reset password"}
          </h2>
          <p style={{margin:"0 0 22px", fontSize:13, color:C.textSub, fontFamily:F}}>
            {mode==="signin"  ? "Sign in to your DealHive account" :
             mode==="signup"  ? TRIAL_DAYS+" days free. No credit card required." :
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
              {...btnStyle("primary","lg", {width:"100%", marginTop:6, marginBottom:14})}>
              {loading ? "Please wait..." :
               mode==="signin"  ? "Sign in" :
               mode==="signup"  ? <>Start free trial <I.arrowRight size={14}/></> :
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
        </Card>
        <div style={{textAlign:"center", marginTop:18, fontSize:12, color:C.textMuted, fontFamily:F}}>
          © 2025 DealHive · dealhive.io
        </div>
      </div>
    </div>
  );
}

// -- Leaflet Map ---------------------------------------------------------------
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
    <SectionBlock title="Appreciation projector" color={C.green} collapsible defaultOpen={false}>
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

// -- Calculator ----------------------------------------------------------------
function Calculator({p, set, renoRates={light:7,medium:13,full:45}, mobile, stickyTop}) {
  const u   = (f,v) => set({...p, [f]:v});
  const m   = calc(p);
  const s   = p.chosenStrategy || "finance";

  return (
    <div>
      {/* Strategy tabs — sticky on mobile so the cash/finance switch stays in view */}
      <div style={{display:"flex", gap:0, marginBottom:18, padding:4,
        background:C.bgSubtle, borderRadius:C.r2, border:"1px solid "+C.border,
        ...(mobile && stickyTop ? {position:"sticky", top:stickyTop, zIndex:40} : {})}}>
        {[["cash","All cash"],["finance","Financed"]].map(([id,label]) => {
          const active = s===id;
          return (
            <button key={id} onClick={()=>u("chosenStrategy",id)}
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

      {/* Rent estimate banner */}
      {p.rentEstimate > 0 && (
        <Card style={{padding:16, marginBottom:16, borderColor:C.greenBorder, background:C.greenSubtle}}>
          <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12}}>
            <div>
              <div style={{fontSize:11, fontWeight:600, color:C.greenDark, fontFamily:F, letterSpacing:".04em", textTransform:"uppercase"}}>
                Market rent estimate
              </div>
              <div style={{fontSize:24, fontWeight:700, color:C.text, fontFamily:F, marginTop:4, fontVariantNumeric:"tabular-nums", letterSpacing:"-0.02em"}}>
                {$(p.rentEstimate)}<span style={{fontSize:14, color:C.textSub, fontWeight:500}}>/mo</span>
              </div>
              <div style={{fontSize:12, color:C.textSub, fontFamily:F, marginTop:2, fontVariantNumeric:"tabular-nums"}}>
                Range {$(p.rentEstLow)} – {$(p.rentEstHigh)}
              </div>
            </div>
            <button onClick={()=>u("rentAmount", p.rentEstimate)} {...btnStyle("primary","sm")}>
              Use estimate
            </button>
          </div>
          {p.rentAmount > 0 && (
            <div style={{fontSize:12, marginTop:10, color:p.rentAmount>=p.rentEstimate?C.greenDark:C.amberDark, fontFamily:F, lineHeight:1.5}}>
              Your rent <b style={{fontWeight:600}}>{$(p.rentAmount)}/mo</b> · {p.rentAmount>=p.rentEstimate?"at or above market":"below market"}
            </div>
          )}
        </Card>
      )}

      <div style={{display:"grid", gridTemplateColumns:mobile?"1fr":"1fr 1fr", gap:14}}>

        {/* All cash — shown on the All cash tab only */}
        {s==="cash" && (
        <SectionBlock title="All cash" color={C.amber}>
          <InputField label="Purchase price" val={p.purchasePrice} set={v=>u("purchasePrice",v)} pre="$" mobile={mobile} />
          <InputField label="Repair costs" val={p.repairCosts} set={v=>u("repairCosts",v)} pre="$" mobile={mobile} />
          <InputField label="Monthly rent" val={p.rentAmount} set={v=>u("rentAmount",v)} pre="$" mobile={mobile} />
          <InputField label="Vacancy rate" val={p.vacancyRate ?? 5} set={v=>u("vacancyRate",v)} suf="%" note="5% ≈ 18 vacant days/yr" mobile={mobile} />
          {(p.vacancyRate||0) > 0 && <DataRow label="Effective rent / mo" value={$(m.effectiveRent)} color={C.textSub} />}
          <DataRow label="Cash flow / mo" value={$mo(m.cashCF)} color={cfC(m.cashCF)} />
          <DataRow label="Out of pocket" value={$(m.cashOOP)} />
          <DataRow label="Cash-on-cash" value={pct(m.cashCoC)} color={cfC(m.cashCoC)} />
          <DataRow label="Cap rate" value={pct(m.cashCap)} />
        </SectionBlock>
        )}

        {/* Financed — shown on the Financed tab only */}
        {s==="finance" && (
        <SectionBlock title="Financed" color={C.green}>
          <InputField label="Purchase price" val={p.purchasePrice} set={v=>u("purchasePrice",v)} pre="$" mobile={mobile} />
          <InputField label="Down payment" val={p.downPaymentPct} set={v=>u("downPaymentPct",v)} suf="%" mobile={mobile} />
          <InputField label="Interest rate" val={p.interestRate} set={v=>u("interestRate",v)} suf="%" mobile={mobile} />
          <InputField label="Closing costs" val={p.closingCosts!=null?p.closingCosts:DEFAULT_CLOSING}
            set={v=>u("closingCosts",v)} pre="$" note={"Default $"+DEFAULT_CLOSING.toLocaleString()} mobile={mobile} />
          <DataRow label="Down payment" value={$(m.down)} />
          <DataRow label="Loan amount" value={$(m.loan)} />
          <DataRow label="Mortgage / mo" value={$mo(m.mtg)} />
          <DataRow label="Cash flow / mo" value={$mo(m.finCF)} color={cfC(m.finCF)} />
          <DataRow label="Out of pocket" value={$(m.finOOP)} />
          <div style={{fontSize:11, color:C.textMuted, fontFamily:F, padding:"2px 0 6px"}}>Down + repairs + closing costs</div>
          <DataRow label="Cash-on-cash" value={pct(m.finCoC)} color={cfC(m.finCoC)} />
          <DataRow label="Cap rate" value={pct(m.finCap)} />
          <DataRow label="Years to payoff" value={m.payoff>0 ? m.payoff.toFixed(1)+" yrs" : "—"} />
        </SectionBlock>
        )}

        {/* Monthly expenses — shown on both tabs (shared data) */}
        <SectionBlock title="Monthly expenses" color={C.green}>
          <InputField label="Property tax / mo" val={p.expPropTax} set={v=>u("expPropTax",v)} pre="$" mobile={mobile} />
          <InputField label="Utilities / mo" val={p.expUtilities} set={v=>u("expUtilities",v)} pre="$" mobile={mobile} />
          <InputField label="Management / mo" val={p.expManagement} set={v=>u("expManagement",v)} pre="$" mobile={mobile} />
          <InputField label="Insurance / mo" val={p.expInsurance} set={v=>u("expInsurance",v)} pre="$" mobile={mobile} />
          <DataRow label="Total expenses / mo" value={$(m.exp)} />
          <DataRow label="NOI / yr" value={$(m.noi*12)} />
          <DataRow label="Yearly rent" value={$((p.rentAmount||0)*12)} />
        </SectionBlock>

        {/* BRRRR — All cash tab only */}
        {s==="cash" && (
        <SectionBlock title="BRRRR estimate" color={C.purple} collapsible defaultOpen={false}>
          <div style={{fontSize:12, color:C.textSub, background:C.bgSubtle, padding:"8px 12px",
            borderRadius:C.r2, marginBottom:14, fontFamily:F, lineHeight:1.5}}>
            Buy with cash → rehab → cash-out refi → keep as rental.
          </div>
          <InputField label="Cash-out refi amount" val={p.brrrCashOut ?? Math.round((p.homeValueMedian||0)*0.8)}
            set={v=>u("brrrCashOut",v)} pre="$" note="Pre-filled at 80% of median" mobile={mobile} />
          <DataRow label="80% of median (suggested)" value={$(Math.round((p.homeValueMedian||0)*0.8))} color={C.textMuted} />
          <DataRow label="Est. mortgage / mo" value={$mo(m.brrrMtg)} />
          <DataRow label="BRRRR cash flow / mo" value={$mo(m.brrrCF)} color={cfC(m.brrrCF)} />
          <DataRow label="Cash recovered" value={$(m.brrrCashOut - m.cashOOP)} color={cfC(m.brrrCashOut - m.cashOOP)} />
        </SectionBlock>
        )}

        {/* Fix & flip — All cash tab only */}
        {s==="cash" && (
        <SectionBlock title="Fix & flip" color={C.amber} collapsible defaultOpen={false}>
          <div style={{fontSize:12, color:C.textSub, background:C.bgSubtle, padding:"8px 12px",
            borderRadius:C.r2, marginBottom:14, fontFamily:F, lineHeight:1.5}}>
            ARV pre-filled from your high home value.
          </div>
          <InputField label="Sale price (ARV)" val={p.flipSalePrice||0} set={v=>u("flipSalePrice",v)} pre="$" mobile={mobile} />
          <InputField label="Agent fee" val={p.agentFeePct ?? 6} set={v=>u("agentFeePct",v)} suf="%" mobile={mobile} />
          <DataRow label="Total into deal" value={$(m.cashOOP)} />
          <DataRow label="Agent fee" value={$(m.agentFee)} />
          <DataRow label="Net profit" value={$(m.flipProfit)} color={cfC(m.flipProfit)} />
          <DataRow label="ROI" value={pct(m.flipROI)} color={cfC(m.flipProfit)} />
        </SectionBlock>
        )}

        {/* Repair Estimator — shown on both tabs */}
        <SectionBlock title="Repair estimator" color={C.borderHover}>
          {p.sqft>0 && (
            <div style={{fontSize:12, color:C.textSub, background:C.bgSubtle, padding:"8px 12px",
              borderRadius:C.r2, marginBottom:14, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>
              {(p.sqft).toLocaleString()} sqft × {`$${renoRates.light}/$${renoRates.medium}/$${renoRates.full}`}/sqft
            </div>
          )}
          <InputField label="Light reno" val={p.repairLight||0} set={v=>u("repairLight",v)} pre="$" mobile={mobile} />
          <InputField label="Medium reno" val={p.repairMedium||0} set={v=>u("repairMedium",v)} pre="$" mobile={mobile} />
          <InputField label="Full reno" val={p.repairFull||0} set={v=>u("repairFull",v)} pre="$" mobile={mobile} />
        </SectionBlock>

        {/* Home Value */}
        <SectionBlock title="Home value" color={C.blue}>
          <InputField label="Low" val={p.homeValueLow||0} set={v=>u("homeValueLow",v)} pre="$" mobile={mobile} />
          <InputField label="Median" val={p.homeValueMedian||0}
            set={v=>{ set({...p, homeValueMedian:v, brrrCashOut:Math.round(v*0.8)}); }} pre="$" mobile={mobile} />
          <InputField label="High (ARV)" val={p.homeValueHigh||0}
            set={v=>{ set({...p, homeValueHigh:v, flipSalePrice:v}); }} pre="$" mobile={mobile} />
          <DataRow label="Tax value" value={$(p.taxValue)} />
          <DataRow label="80% of median (BRRRR)" value={$(Math.round((p.homeValueMedian||0)*0.8))} color={C.purple} />
        </SectionBlock>

        {/* Summary */}
        <SectionBlock title="Summary" color={C.text}>
          <DataRow label="Strategy" value={(p.chosenStrategy||"finance")==="cash"?"All cash":"Financed"} />
          <DataRow label="Out of pocket" value={$(m.chosenOOP)} />
          <DataRow label="Net cash flow / mo" value={$mo(m.chosenCF)} color={cfC(m.chosenCF)} />
          <DataRow label="Cash-on-cash" value={pct(m.chosenCoC)} color={cfC(m.chosenCoC)} />
          <DataRow label="Cap rate" value={pct(m.chosenCap)} />
          <DataRow label="Years to payoff" value={m.payoff>0 ? m.payoff.toFixed(1)+" yrs" : "—"} />
          <DataRow label="Yearly rent (gross)" value={$((p.rentAmount||0)*12)} />
        </SectionBlock>

      </div>

      {/* Appreciation Projector */}
      <AppreciationProjector homeValue={p.homeValueMedian} purchasePrice={p.purchasePrice} mobile={mobile} />

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
                  <div style={{position:"relative", height:140, overflow:"hidden"}}>
                    <img src={svUrl(p.lat,p.lng,900,280)} alt="" style={{width:"100%", height:"100%", objectFit:"cover"}} />
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
                        <div style={{fontSize:10, color:C.textMuted, fontFamily:F, fontWeight:500, letterSpacing:".03em", textTransform:"uppercase"}}>{l}</div>
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
                      <div style={{width:54, height:54, borderRadius:C.r2, overflow:"hidden", flexShrink:0, border:"1px solid "+C.border}}>
                        <img src={svUrl(p.lat,p.lng,120,120)} alt=""
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
                        <div style={{width:38, height:38, borderRadius:C.r2, overflow:"hidden", flexShrink:0, border:"1px solid "+C.border}}>
                          <img src={svUrl(p.lat,p.lng,88,88)} alt=""
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
function PropertyDetail({prop, onBack, onChange, onDelete, llcs, renoRates, mobile, apiLookup, rentcastKey}) {
  const [tab, setTab] = useState("overview");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState("");
  const m = calc(prop);
  const u = (f,v) => onChange({...prop, [f]:v});
  const tabs = [["overview","Overview"],["calculator","Calculator"],["tenant","Tenant"],["projects","Projects"],["expenses","Expenses"],["notes","Notes"]];

  // Re-pull public records for an existing property. applyRentcast only
  // overwrites public-record + valuation fields, so the user's ownership,
  // lockbox, purchase price, rent, tenant, projects and expenses are kept.
  const refreshData = async () => {
    if (!rentcastKey) { setRefreshErr("Add your RentCast API key on the Lease Comps page first."); return; }
    setRefreshing(true); setRefreshErr("");
    try {
      const key = lookupKey("rc-detail", prop.address, prop.city, prop.state, prop.zip);
      const d = await apiLookup(key, () => rentcastFetch(prop.address, prop.city, prop.state, prop.zip, rentcastKey));
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
            [`Cash flow / mo (${prop.chosenStrategy==="cash"?"Cash":"Financed"})`, $mo(m.chosenCF), cfC(m.chosenCF)],
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
        {tab==="calculator" && <Calculator p={prop} set={onChange} renoRates={renoRates} mobile={mobile} stickyTop="calc(env(safe-area-inset-top, 0px) + 166px)" />}
        {tab==="tenant"     && <TenantSection p={prop} set={onChange} mobile={mobile} />}
        {tab==="projects"   && <PropertyProjectsTab p={prop} set={onChange} mobile={mobile} />}
        {tab==="expenses"   && <ExpensesTab p={prop} set={onChange} mobile={mobile} />}
        {tab==="notes"      && (
          <SectionBlock title="Notes" color={C.text}>
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

// MMM D, h:mm a — for the call-note timeline timestamps.
const formatNoteStamp = (d=new Date()) => d.toLocaleString("en-US", {
  month:"short", day:"numeric", hour:"numeric", minute:"2-digit", hour12:true,
});

// -- Call-note (notebook) date helpers -----------------------------------------
// New notes store an ISO `ts`; legacy notes only have a formatted `date` string.
const noteDate = (n) => {
  if (n && n.ts) { const d = new Date(n.ts); return isNaN(d) ? null : d; }
  return null; // legacy notes (no ts) get bucketed under "Earlier"
};
const dayKeyOf = (d) => d ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : "earlier";
const dayLabelOf = (d) => {
  if (!d) return "Earlier notes";
  const today = startOfToday();
  const that  = new Date(d); that.setHours(0,0,0,0);
  const diff  = Math.round((that - today) / 86400000);
  const md    = d.toLocaleDateString("en-US", {month:"long", day:"numeric"});
  const wd    = d.toLocaleDateString("en-US", {weekday:"long"});
  if (diff === 0)  return `Today · ${wd}, ${md}`;
  if (diff === -1) return `Yesterday · ${md}`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return sameYear ? `${wd}, ${md}` : `${md}, ${d.getFullYear()}`;
};
const noteTimeOf = (n) => {
  const d = noteDate(n);
  if (d) return d.toLocaleTimeString("en-US", {hour:"numeric", minute:"2-digit", hour12:true});
  return n.date || ""; // legacy fallback shows whatever string we stored
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

// Render **bold** markdown inline (used in call notes).
const renderRich = (text) => {
  if (!text) return null;
  return String(text).split(/(\*\*[^*\n]+\*\*)/g).map((p, i) =>
    /^\*\*[^*\n]+\*\*$/.test(p)
      ? <strong key={i} style={{fontWeight:700}}>{p.slice(2, -2)}</strong>
      : p
  );
};

// Wrap the current selection of a textarea (by ref) in ** ** for bold.
const wrapSelectionBold = (taRef, value, setValue) => {
  const ta = taRef.current;
  if (!ta) { setValue((value||"") + "****"); return; }
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = value.slice(s, e);
  const inner = sel || "bold text";
  const next = value.slice(0, s) + "**" + inner + "**" + value.slice(e);
  setValue(next);
  requestAnimationFrame(() => {
    ta.focus();
    const pos = s + 2;
    ta.setSelectionRange(pos, pos + inner.length);
  });
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

// Newest-first call-note timeline + inline "Add a note…" input.
// Notebook-style call notes. Opens to "today's page" — today's date is written
// at the top automatically, with a writing area beneath it. Past calls are
// grouped under their own dated headings below, newest day first.
function CallNotesTimeline({pr, onChange, mobile}) {
  const [text, setText]       = useState("");   // today's compose box
  const [editKey, setEditKey] = useState(null); // which saved note is open for editing
  const [editVal, setEditVal] = useState("");
  const composeRef = useRef(null);
  const editRef    = useRef(null);

  const log = pr.log || [];
  const keyOf = (ref) => ref.type === "details" ? "details" : `log-${ref.idx}`;

  // Every note, tagged with an edit ref.
  const all = [
    ...(pr.details ? [{date:"", note: pr.details, ref:{type:"details"}}] : []),
    ...log.map((n, i) => ({...n, ref:{type:"log", idx:i}})),
  ];

  // Bucket by calendar day.
  const buckets = {};
  all.forEach(n => {
    const d = noteDate(n);
    const key = dayKeyOf(d);
    if (!buckets[key]) buckets[key] = {label: dayLabelOf(d), sortTs: d ? d.getTime() : -1, notes: []};
    buckets[key].notes.push(n);
  });
  const todayKey   = dayKeyOf(new Date());
  const todayLabel = dayLabelOf(new Date());
  const todayNotes = (buckets[todayKey]?.notes || []).slice().reverse();
  const pastSections = Object.entries(buckets)
    .filter(([k]) => k !== todayKey)
    .sort((a,b) => b[1].sortTs - a[1].sortTs);

  const saveNew = () => {
    const v = text.trim();
    if (!v) return;
    onChange({...pr, log: [...log, {ts: new Date().toISOString(), note: v}]});
    setText("");
  };
  const commitEdit = (ref) => {
    const v = editVal.trim();
    if (ref.type === "details") {
      onChange({...pr, details: v});
    } else if (!v) {
      onChange({...pr, log: log.filter((_, i) => i !== ref.idx)});
    } else {
      onChange({...pr, log: log.map((n, i) => i === ref.idx ? {...n, note: v} : n)});
    }
    setEditKey(null); setEditVal("");
  };
  const deleteNote = (ref) => {
    if (ref.type === "details") onChange({...pr, details: ""});
    else onChange({...pr, log: log.filter((_, i) => i !== ref.idx)});
    setEditKey(null); setEditVal("");
  };
  const startEdit = (n) => { setEditKey(keyOf(n.ref)); setEditVal(n.note); };

  // --- Notepad styling ---
  const LINE_H = 28;
  const PAPER  = "#FFFEFB";
  const RULE   = "#D9E2EC";          // soft blue-gray ruled line
  const MARGIN = "#EFC9C9";          // pink margin line
  const lined = {
    lineHeight: `${LINE_H}px`,
    backgroundImage: `repeating-linear-gradient(transparent, transparent ${LINE_H-1}px, ${RULE} ${LINE_H-1}px, ${RULE} ${LINE_H}px)`,
    backgroundAttachment: "local",
    backgroundColor: "transparent",
  };
  const noteFont = {fontFamily:F, fontSize:14, color:C.text};

  // A single saved note — click to edit in place.
  // Plain render-fn (not a component) so editing textareas don't remount on keystroke.
  const renderNote = (n) => {
    const editing = editKey === keyOf(n.ref);
    const stamp = noteTimeOf(n);
    return (
      <div key={keyOf(n.ref)} style={{paddingTop:6}}>
        <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", minHeight:16}}>
          <span style={{fontSize:11, color:C.textMuted, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>
            {stamp || "Note"}
          </span>
          {editing && (
            <button onClick={()=>deleteNote(n.ref)}
              style={{background:"none", border:"none", padding:0, cursor:"pointer",
                color:C.textMuted, fontFamily:F, fontSize:11, display:"inline-flex", alignItems:"center", gap:4}}>
              <I.trash size={11}/> Delete
            </button>
          )}
        </div>
        {editing ? (
          <div>
            <textarea ref={editRef} value={editVal} autoFocus
              onChange={e=>setEditVal(e.target.value)}
              onKeyDown={e=>{
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEdit(n.ref); }
                if (e.key === "Escape") { setEditKey(null); setEditVal(""); }
              }}
              style={{...lined, ...noteFont, width:"100%", border:"none", outline:"none",
                resize:"vertical", padding:0, minHeight:LINE_H, display:"block"}} />
            <div style={{display:"flex", gap:6, marginTop:6, alignItems:"center"}}>
              <button type="button" onMouseDown={e=>{e.preventDefault(); wrapSelectionBold(editRef, editVal, setEditVal);}}
                title="Bold (or wrap text in **)" style={boldBtnStyle}>B</button>
              <span style={{flex:1}} />
              <button onClick={()=>commitEdit(n.ref)} {...btnStyle("primary","sm")}>Save</button>
            </div>
          </div>
        ) : (
          <div onClick={()=>startEdit(n)}
            title="Tap to edit"
            style={{...lined, ...noteFont, whiteSpace:"pre-wrap", cursor:"text",
              minHeight:LINE_H, wordBreak:"break-word"}}>
            {renderRich(n.note)}
          </div>
        )}
      </div>
    );
  };

  const sectionPad = mobile ? "12px 16px 14px 16px" : "14px 18px 16px 18px";
  const boldBtnStyle = {
    width:26, height:26, borderRadius:C.r1, border:"1px solid "+C.border,
    background:C.card, color:C.text, fontFamily:"Georgia, serif", fontWeight:700,
    fontSize:13, cursor:"pointer", lineHeight:1, flexShrink:0,
    display:"inline-flex", alignItems:"center", justifyContent:"center",
  };

  return (
    <div style={{marginBottom:14}}>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12}}>
        <div style={{display:"flex", alignItems:"center", gap:8}}>
          <div style={{width:3, height:13, background:C.green, borderRadius:2}} />
          <span style={{fontSize:12, fontWeight:700, color:C.textSub, fontFamily:F, letterSpacing:".04em", textTransform:"uppercase"}}>Call notes</span>
        </div>
        <span style={{fontSize:11, color:C.textMuted, fontFamily:F}}>Tap a note to edit</span>
      </div>
      <div style={{
        borderRadius:C.r3, border:"1px solid "+C.border, overflow:"hidden",
        background:PAPER, boxShadow:"inset 3px 0 0 "+MARGIN,
      }}>
        {/* Today's page */}
        <div style={{padding:sectionPad}}>
          <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:10}}>
            <span style={{width:7, height:7, borderRadius:"50%", background:C.green, flexShrink:0}}/>
            <span style={{fontSize:12, fontWeight:700, color:C.greenDark, fontFamily:F, letterSpacing:".03em", textTransform:"uppercase"}}>
              {todayLabel}
            </span>
          </div>
          <textarea ref={composeRef} value={text} onChange={e=>setText(e.target.value)}
            onKeyDown={e=>{ if ((e.metaKey||e.ctrlKey) && e.key==="Enter") saveNew(); }}
            placeholder="Start writing…"
            rows={3}
            style={{...lined, ...noteFont, width:"100%", border:"none", outline:"none",
              resize:"vertical", padding:0, minHeight:LINE_H*3, display:"block",
              color:C.text}} />
          <div style={{display:"flex", gap:10, marginTop:8, alignItems:"center", paddingTop:10, borderTop:"1px solid "+RULE}}>
            <button type="button" onMouseDown={e=>{e.preventDefault(); wrapSelectionBold(composeRef, text, setText);}}
              title="Bold the selected text" style={boldBtnStyle}>B</button>
            {!mobile && <span style={{fontSize:11, color:C.textMuted, fontFamily:F}}>Select text, then tap B to bold</span>}
            <span style={{flex:1}} />
            <button onClick={saveNew} disabled={!text.trim()}
              {...btnStyle("primary","sm", text.trim()?{}:{opacity:.45, cursor:"not-allowed"})}>
              <I.plus size={12}/> Add note
            </button>
          </div>
          {todayNotes.length > 0 && (
            <div style={{marginTop:10, borderTop:"1px solid "+C.border, paddingTop:2}}>
              {todayNotes.map(n=>renderNote(n))}
            </div>
          )}
        </div>

        {/* Past pages */}
        {pastSections.map(([key, sec]) => (
          <div key={key} style={{padding:sectionPad, borderTop:"1px solid "+C.border, background:"rgba(15,23,42,.015)"}}>
            <div style={{fontSize:12, fontWeight:600, color:C.textSub, fontFamily:F, letterSpacing:".03em", textTransform:"uppercase", marginBottom:8}}>
              {sec.label}
            </div>
            {sec.notes.slice().reverse().map(n=>renderNote(n))}
          </div>
        ))}
      </div>
    </div>
  );
}

function FollowupExpanded({pr, onChange, onDelete, mobile, contractors=[], onAddExpense, isExpensed}) {
  const u = (f, v) => onChange({...pr, [f]:v});
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
    <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:12}}>
      <div style={{width:3, height:13, background:C.green, borderRadius:2}} />
      <span style={{fontSize:12, fontWeight:700, color:C.textSub, fontFamily:F, letterSpacing:".04em", textTransform:"uppercase"}}>{text}</span>
    </div>
  );
  const divider = <div style={{height:1, background:C.border, margin: mobile ? "18px 0" : "20px 0"}} />;
  const labelStyle = {fontSize:13, color:C.text, fontWeight:500, display:"block", marginBottom:6, fontFamily:F};

  return (
    <div style={{padding: mobile ? "16px 14px 16px" : "20px 22px 18px", background:C.card, borderTop:"1px solid "+C.border}}>
      {sectionLabel("Details")}
      <InputField label="What needs doing" type="text" val={pr.name||""} set={v=>u("name",v)} mobile={mobile} />
      <div style={{marginBottom:14}}>
        <label style={labelStyle}>Type</label>
        <TypePicker value={typeOf(pr)} onChange={v=>u("type",v)} />
      </div>
      <div style={{display:"grid", gridTemplateColumns: mobile ? "minmax(0,1fr) minmax(0,1fr)" : "repeat(4, minmax(0,1fr))", gap: mobile?10:12}}>
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

      {divider}

      <CallNotesTimeline pr={pr} onChange={onChange} mobile={mobile} />

      {divider}

      {sectionLabel("Attachments")}
      <PhotoUploader photos={pr.photos||[]} onChange={v=>u("photos",v)} />
      <FileUploader files={pr.files||[]} onChange={v=>u("files",v)} mobile={mobile} />

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
    onChange({...pr, status: isDone ? "In Progress" : "Complete"});
  };
  const snooze = () => onChange({...pr, dueDate: nextDayIso(pr.dueDate)});
  const openNoteBar = () => {
    if (expanded) { setExpanded(false); }
    setNoteOpen(true);
  };
  const submitInlineNote = () => {
    const v = noteText.trim();
    if (!v) return;
    onChange({...pr, log: [...(pr.log||[]), {date: formatNoteStamp(), note: v}]});
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
      const hay = `${pr.name||""} ${pr.contractor||""} ${pr.details||""} ${(pr.log||[]).map(l=>l.note).join(" ")}`.toLowerCase();
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
  const summary = status.openCount === 0
    ? "All clear"
    : status.overdueCount > 0
      ? `${status.openCount} open · ${status.overdueCount} overdue`
      : `${status.openCount} open`;

  return (
    <Card id={"prop-"+property.id} className="dh-prop-card"
      style={{marginBottom:14}} padding={0}>
      {!hideHeader && (
        <header style={{padding:mobile?"12px 14px":"14px 16px", display:"flex", justifyContent:"space-between", alignItems:"center", gap:10, borderBottom:projects.length||filterMode!=="open"?"1px solid "+C.bgSubtle:"none"}}>
          <div style={{minWidth:0, flex:1}}>
            <h3 style={{margin:0, fontSize:mobile?16:18, fontWeight:600, color:C.text, fontFamily:F, letterSpacing:"-0.015em",
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{property.address}</h3>
            <div style={{fontSize:mobile?12:13, color:"#71717a", fontFamily:F, marginTop:1,
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
              {property.city}{property.state?`, ${property.state}`:""}
            </div>
          </div>
          <div style={{display:"inline-flex", alignItems:"center", gap:6, flexShrink:0}}>
            <span className={status.kind === "overdue" ? "dh-pulse" : undefined}
              style={{width:8, height:8, borderRadius:"50%", background:status.color, flexShrink:0}}/>
            <span style={{fontSize:12, color:C.textSub, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>
              {summary}
            </span>
          </div>
        </header>
      )}
      {sorted.length === 0 ? (
        <div style={{padding:"30px 16px 24px", textAlign:"center", display:"flex", flexDirection:"column", alignItems:"center", gap:6}}>
          {!search && filterMode === "open" ? (
            <>
              <div style={{
                width:36, height:36, borderRadius:"50%", background:C.greenSubtle,
                border:"1px solid "+C.greenBorder, color:C.greenDark,
                display:"flex", alignItems:"center", justifyContent:"center",
              }}>
                <I.check size={17} stroke={2.5}/>
              </div>
              <div style={{fontSize:13, color:"#71717a", fontFamily:F}}>All caught up on this property</div>
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

function DueNowSection({title, items, bg, labelColor, onPropertyClick, onRowChange, onRowDelete, onAddExpense, mobile, contractors}) {
  if (!items.length) return null;
  return (
    <div style={{background: bg}}>
      <header style={{padding:mobile?"10px 14px":"10px 16px", display:"flex", alignItems:"center", gap:10}}>
        <span style={{fontSize:11, fontWeight:700, color:labelColor, fontFamily:F, letterSpacing:".06em", textTransform:"uppercase"}}>
          {title}
        </span>
        <span style={{fontSize:11, color:labelColor, fontFamily:F, fontWeight:600, fontVariantNumeric:"tabular-nums",
          background:"rgba(255,255,255,.65)", border:"1px solid rgba(0,0,0,.05)", padding:"1px 8px", borderRadius:9999}}>
          {items.length}
        </span>
      </header>
      {items.map(({pr, property}) => (
        <FollowupRow key={`${property.id}-${pr.id}`} pr={pr}
          propLabel={property.address} propId={property.id} showProperty
          onPropertyClick={() => onPropertyClick(property.id)}
          onChange={updated => onRowChange(property, updated)}
          onDelete={() => onRowDelete(property, pr.id)}
          onAddExpense={exp => onAddExpense(property, exp)}
          isExpensed={(property.expenses||[]).some(e => e.fromFollowup === pr.id)}
          mobile={mobile} contractors={contractors} />
      ))}
    </div>
  );
}

function ProjectsPage({properties, onUpdateProperty, mobile}) {
  const isWide = useIsWide();
  const [filterMode, setFilterMode] = useState("open");
  const [search, setSearch]         = useState("");
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

  return (
    <div style={{
      background:pageBg, minHeight:"100%",
      paddingTop:    mobile ? 20 : 32,
      paddingBottom: mobile ? 100 : 32,
      paddingLeft:   `calc(${mobile?24:32}px + env(safe-area-inset-left, 0px))`,
      paddingRight:  `calc(${mobile?24:32}px + env(safe-area-inset-right, 0px))`,
    }}>
      <PageHeader
        title="Projects"
        subtitle={openTotal === 0
          ? "All clear — no open follow-ups."
          : `${openTotal} open follow-up${openTotal===1?"":"s"} across ${properties.length} ${properties.length===1?"property":"properties"}.`}
      />

      {dueNowTotal > 0 && (
        <Card style={{marginBottom:24}} padding={0}>
          <DueNowSection title="Overdue"   items={overdue}    bg="#FEF2F2" labelColor="#991b1b"
            onPropertyClick={scrollToProperty} onRowChange={handleRowChange} onRowDelete={handleRowDelete} onAddExpense={handleAddExpense} mobile={mobile} contractors={contractors}/>
          {overdue.length > 0 && (todayItems.length > 0 || thisWeek.length > 0) && <div style={{height:1, background:C.border}}/>}
          <DueNowSection title="Today"     items={todayItems} bg="#FFFBEB" labelColor="#92400e"
            onPropertyClick={scrollToProperty} onRowChange={handleRowChange} onRowDelete={handleRowDelete} onAddExpense={handleAddExpense} mobile={mobile} contractors={contractors}/>
          {todayItems.length > 0 && thisWeek.length > 0 && <div style={{height:1, background:C.border}}/>}
          <DueNowSection title="This week" items={thisWeek}   bg="#FAFAFA" labelColor="#3f3f46"
            onPropertyClick={scrollToProperty} onRowChange={handleRowChange} onRowDelete={handleRowDelete} onAddExpense={handleAddExpense} mobile={mobile} contractors={contractors}/>
        </Card>
      )}

      {/* Filter + search */}
      <div style={{display:"flex", gap:10, marginBottom:12, flexWrap:"wrap"}}>
        <div style={{display:"flex", gap:6}}>
          {[["open","Open"],["done","Done"],["all","All"]].map(([id,label]) => (
            <button key={id} onClick={()=>setFilterMode(id)}
              {...btnStyle(filterMode===id?"primary":"secondary","sm")}>{label}</button>
          ))}
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
        <div className="dh-chip-row" style={{display:"flex", gap:6, marginBottom:18, overflowX:"auto",
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
        <div style={{display:"flex", gap:6}}>
          <button onClick={()=>setFilterMode("open")} {...btnStyle(filterMode==="open"?"primary":"secondary","sm")}>
            Open{openCount?` · ${openCount}`:""}
          </button>
          <button onClick={()=>setFilterMode("done")} {...btnStyle(filterMode==="done"?"primary":"secondary","sm")}>
            Done{doneCount?` · ${doneCount}`:""}
          </button>
          <button onClick={()=>setFilterMode("all")} {...btnStyle(filterMode==="all"?"primary":"secondary","sm")}>All</button>
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

// -- Deal Analyzer -------------------------------------------------------------
function DealAnalyzer({deals=[], onSave, renoRates={light:7,medium:13,full:45}, onMoveToPortfolio, mobile, apiLookup, rentcastKey}) {
  const [d, setD]       = useState(() => newDeal());
  const [loading, setL] = useState(false);
  const [err, setErr]   = useState("");
  const u = (f,v) => setD(prev => ({...prev, [f]:v}));

  const runSearch = async () => {
    if (!d.address) { setErr("Enter an address first."); return; }
    if (!rentcastKey) { setErr("Add your RentCast API key first — paste it on the Lease Comps page."); return; }
    setL(true); setErr("");
    try {
      const key = lookupKey("rc-detail", d.address, d.city, d.state, d.zip);
      const data = await apiLookup(key, () => rentcastFetch(d.address, d.city, d.state, d.zip, rentcastKey));
      if (!rcHasData(data)) setErr("No property data found for that address. Try adding city, state and ZIP.");
      else setD(prev => applyRentcast(prev, data, renoRates));
    } catch (e) {
      setErr(e && e.code === "CAP" ? LOOKUP_CAP_MSG : "Search failed. Check the address and try again.");
    }
    setL(false);
  };

  const saveDeal = () => {
    if (!d.address) { setErr("Enter an address first."); return; }
    onSave([...deals.filter(x => x.id !== d.id), {...d, savedAt:new Date().toISOString()}]);
    setD(newDeal()); setErr("");
  };

  const m = calc(d);
  const cashScore = (m.cashCF>0?30:0) + Math.min(m.cashCoC,20) + (m.cashCoC>8?20:0);
  const finScore  = (m.finCF>0?30:0)  + Math.min(m.finCoC,20)  + (m.finCoC>10?20:0);
  const winner    = finScore >= cashScore ? "finance" : "cash";

  return (
    <div style={{padding:mobile?"20px 16px 100px":"32px 32px"}}>
      <PageHeader title="Deal Analyzer" subtitle="Analyze any deal before you make an offer"
        action={<button onClick={()=>{setD(newDeal());setErr("");}} {...btnStyle("secondary","md")}><I.x size={13}/> Clear</button>} />

      {/* Address */}
      <SectionBlock title="Property" color={C.green}>
        <div style={{marginBottom:12}}>
          <label style={{fontSize:13, color:C.text, fontWeight:500, display:"block", marginBottom:6, fontFamily:F}}>
            Address
          </label>
          <AddressInput value={d.address} onChange={v=>u("address",v)}
            onSelect={loc=>setD(prev=>({...prev,...loc,fullAddress:loc.fullAddress}))}
            placeholder="Start typing an address…"
            mobile={mobile} />
        </div>
        <StreetViewImg lat={d.lat} lng={d.lng} address={d.fullAddress||d.address} height={180} />
        {d.city && (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginTop:6}}>
            {[["City","city"],["State","state"],["ZIP","zip"]].map(([l,f]) => (
              <div key={f}>
                <label style={{fontSize:12, color:C.textSub, fontFamily:F, display:"block", marginBottom:5, fontWeight:500}}>{l}</label>
                <input value={d[f]||""} onChange={e=>u(f,e.target.value)} style={iS(mobile)} />
              </div>
            ))}
          </div>
        )}
        <button onClick={runSearch} disabled={loading}
          {...btnStyle("primary","md", {width:"100%", marginTop:14})}>
          {loading ? "Searching…" : <><I.search size={14}/> Pull property data</>}
        </button>
        {err && (
          <div style={{display:"flex", gap:8, alignItems:"center",
            color:C.redDark, fontSize:13, marginTop:10, fontFamily:F}}>
            <I.alert size={14}/> {err}
          </div>
        )}
        {d.taxValue > 0 && (
          <div style={{marginTop:12, background:C.greenSubtle, border:"1px solid "+C.greenBorder, borderRadius:C.r2, padding:"10px 12px", fontSize:13, fontFamily:F, color:C.greenDark, display:"flex", alignItems:"center", gap:8, flexWrap:"wrap"}}>
            <I.check size={14}/> Found data:
            <span><b style={{fontWeight:600}}>Tax {$(d.expPropTax)}/mo</b></span>
            {d.homeValueMedian>0 && <span>· Market <b style={{fontWeight:600}}>{$(d.homeValueMedian)}</b></span>}
            {d.rentEstimate>0 && <span>· Rent est. <b style={{fontWeight:600}}>{$(d.rentEstimate)}/mo</b></span>}
          </div>
        )}
      </SectionBlock>

      {/* Property snapshot */}
      {d.beds > 0 && (
        <div style={{display:"grid",gridTemplateColumns:"repeat("+(mobile?2:4)+",1fr)",gap:10,marginBottom:18}}>
          {[["Beds",d.beds],["Baths",d.baths],["Sqft",(d.sqft||0).toLocaleString()],["Built",d.yearBuilt]].map(([l,v]) => (
            <Card key={l} style={{padding:"12px 14px"}}>
              <div style={{fontSize:11, color:C.textMuted, fontFamily:F, fontWeight:500, letterSpacing:".03em", textTransform:"uppercase"}}>{l}</div>
              <div style={{fontSize:18, fontWeight:700, color:C.text, fontFamily:F, marginTop:4, fontVariantNumeric:"tabular-nums", letterSpacing:"-0.02em"}}>{v||"—"}</div>
            </Card>
          ))}
        </div>
      )}

      {/* Calculator */}
      <Calculator p={d} set={setD} renoRates={renoRates} mobile={mobile} stickyTop="calc(env(safe-area-inset-top, 0px) + 54px)" />

      {/* Recommendation */}
      {d.purchasePrice > 0 && (() => {
        const isFinance = winner==="finance";
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
                  {isFinance ? "Finance this deal" : "Buy with cash"}
                </div>
              </div>
            </div>
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14}}>
              {[{id:"cash",label:"All cash",cf:m.cashCF,coc:m.cashCoC,oop:m.cashOOP},
                {id:"finance",label:"Financed",cf:m.finCF,coc:m.finCoC,oop:m.finOOP}].map(sv => {
                const win = winner===sv.id;
                return (
                  <div key={sv.id} style={{
                    background: win ? C.greenSubtle : C.bgSubtle,
                    border: "1px solid " + (win ? C.greenBorder : C.border),
                    borderRadius:C.r3, padding:"14px 16px",
                  }}>
                    <div style={{display:"flex", alignItems:"center", gap:6, marginBottom:6}}>
                      <span style={{fontSize:12, fontWeight:600, color:win?C.greenDark:C.textSub, fontFamily:F, letterSpacing:".02em", textTransform:"uppercase"}}>{sv.label}</span>
                      {win && <Badge label="Recommended" bg={C.green} c="#fff"/>}
                    </div>
                    <div style={{fontSize:24, fontWeight:700, color:cfC(sv.cf), fontFamily:F, fontVariantNumeric:"tabular-nums", letterSpacing:"-0.025em"}}>{$mo(sv.cf)}</div>
                    <div style={{display:"flex", gap:14, marginTop:6, fontSize:12, color:C.textSub, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>
                      <span>CoC <b style={{color:C.text, fontWeight:600}}>{pct(sv.coc)}</b></span>
                      <span>OOP <b style={{color:C.text, fontWeight:600}}>{$(sv.oop)}</b></span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{fontSize:13, color:C.textSub, lineHeight:1.6, fontFamily:F}}>
              {isFinance
                ? <>Financing wins — cash-on-cash of <b style={{color:C.text, fontWeight:600}}>{pct(m.finCoC)}</b> is strong, and you keep <b style={{color:C.text, fontWeight:600}}>${Math.round(m.cashOOP-m.finOOP).toLocaleString()}</b> in your pocket. After-mortgage cash flow: <b style={{color:C.text, fontWeight:600}}>{$mo(m.finCF)}</b>.</>
                : <>Cash wins — financed cash flow of <b style={{color:C.text, fontWeight:600}}>{$mo(m.finCF)}</b> is too thin after the mortgage. All-cash gives you <b style={{color:C.text, fontWeight:600}}>{$mo(m.cashCF)}</b>/mo.</>}
            </div>
          </Card>
        );
      })()}

      {/* Deal Notes */}
      <SectionBlock title="Notes" color={C.text}>
        <textarea value={d.notes||""} onChange={e=>u("notes",e.target.value)}
          placeholder="Seller motivation, condition, neighborhood, rehab scope…"
          style={{...iS(mobile), minHeight:110, resize:"vertical", lineHeight:1.55}} />
      </SectionBlock>

      {/* Save */}
      <button onClick={saveDeal}
        {...btnStyle("primary","lg", {width:"100%", marginBottom:24})}>
        Save as {(d.chosenStrategy||"finance")==="cash"?"all-cash":"financed"} deal
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
                    <div style={{height:120, overflow:"hidden", position:"relative"}}>
                      <img src={svUrl(deal.lat,deal.lng,900,200)} alt=""
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
                          <div style={{fontSize:10, color:C.textMuted, fontFamily:F, fontWeight:500, letterSpacing:".03em", textTransform:"uppercase"}}>{l}</div>
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

// -- Lease Comps ---------------------------------------------------------------
function LeaseComps({rentcastKey, onSaveKey, mobile, apiLookup}) {
  const [address,setAddress] = useState("");
  const [location,setLocation] = useState(null);
  const [beds,setBeds]         = useState(3);
  const [autoDetected,setAuto] = useState(false);
  const [loading,setL]         = useState(false);
  const [comps,setComps]       = useState(null);
  const [err,setErr]           = useState("");
  const [showKeyInput,setShowKey] = useState(!rentcastKey);
  const [keyInput,setKeyInput] = useState(rentcastKey||"");

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

  const search = async () => {
    if (!rentcastKey) { setErr("Add your free Rentcast API key first."); return; }
    if (!address)     { setErr("Enter an address first."); return; }
    setL(true); setErr(""); setComps(null);
    try {
      // One comp search = the estimate + the listings, billed as a single lookup.
      const result = await apiLookup(lookupKey("rc-comp", address, beds), async () => {
        const q = encodeURIComponent(address);
        const h = {"X-Api-Key":rentcastKey};
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
      setComps(result);
    } catch (e) { setErr(e && e.code === "CAP" ? LOOKUP_CAP_MSG : "Search failed. Check your API key and address."); }
    setL(false);
  };

  const avg = comps?.listings?.length
    ? Math.round(comps.listings.reduce((s,l)=>s+(l.price||l.rent||0),0)/comps.listings.length)
    : 0;

  return (
    <div style={{padding:mobile?"20px 16px 100px":"32px 32px"}}>
      <PageHeader title="Lease Comps" subtitle="Real rental comps for any address" />

      {(!rentcastKey || showKeyInput) && (
        <Card style={{padding:18, marginBottom:18, borderColor:C.amberBorder, background:C.amberSubtle}}>
          <div style={{display:"flex", alignItems:"center", gap:10, marginBottom:8}}>
            <div style={{
              width:30, height:30, borderRadius:C.r2, background:"#fff", border:"1px solid "+C.amberBorder,
              color:C.amberDark, display:"flex", alignItems:"center", justifyContent:"center",
            }}><I.alert size={15}/></div>
            <div>
              <div style={{fontSize:14, fontWeight:600, color:C.text, fontFamily:F, letterSpacing:"-0.005em"}}>Rentcast API key required</div>
              <div style={{fontSize:12, color:C.amberDark, fontFamily:F, marginTop:1}}>Free tier: 50 searches / month — no credit card.</div>
            </div>
          </div>
          <p style={{fontSize:13, color:C.textSub, fontFamily:F, margin:"0 0 12px", lineHeight:1.5}}>
            Get a key at <a href="https://rentcast.io" target="_blank" rel="noreferrer" style={{color:C.greenDark, fontWeight:600, textDecoration:"underline"}}>rentcast.io</a> and paste it below.
          </p>
          <div style={{display:"flex", gap:8}}>
            <input value={keyInput} onChange={e=>setKeyInput(e.target.value)}
              placeholder="Paste API key…"
              style={{...iS(mobile), flex:1, fontFamily:'"JetBrains Mono", ui-monospace, monospace', fontSize:13}} />
            <button onClick={()=>{if(keyInput){onSaveKey(keyInput);setShowKey(false);}}}
              {...btnStyle("primary","md")}>Save</button>
          </div>
        </Card>
      )}

      <SectionBlock title="Search comps" color={C.green}>
        <div style={{marginBottom:14}}>
          <label style={{fontSize:13, color:C.text, fontWeight:500, display:"block", marginBottom:6, fontFamily:F}}>Address</label>
          <AddressInput value={address} onChange={setAddress} onSelect={handleSelect}
            placeholder="Enter an address to find nearby rentals…" mobile={mobile} />
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
            {loading ? "Searching…" : <><I.search size={14}/> Run search</>}
          </button>
          {rentcastKey && (
            <button onClick={()=>setShowKey(!showKeyInput)} {...btnStyle("secondary","md")}>
              <I.settings size={13}/> Key
            </button>
          )}
        </div>
        {err && (
          <div style={{display:"flex", gap:8, alignItems:"center", color:C.redDark, fontSize:13, marginTop:10, fontFamily:F}}>
            <I.alert size={14}/> {err}
          </div>
        )}
      </SectionBlock>

      {location && <StreetViewImg lat={location.lat} lng={location.lng} address={address} height={180} />}

      {comps && (
        <div>
          {comps.estimate?.rent && (
            <Card style={{padding:24, marginBottom:20, marginTop:6,
              background:"linear-gradient(180deg, #fff 0%, "+C.greenSubtle+" 100%)",
              borderColor:C.greenBorder}}>
              <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:8}}>
                <span style={{fontSize:11, fontWeight:600, color:C.greenDark, fontFamily:F, letterSpacing:".04em", textTransform:"uppercase"}}>
                  Market estimate · {beds} bed
                </span>
              </div>
              <div style={{fontSize:42, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.03em", lineHeight:1, fontVariantNumeric:"tabular-nums"}}>
                {$(comps.estimate.rent)}<span style={{fontSize:18, color:C.textSub, fontWeight:500}}>/mo</span>
              </div>
              <div style={{fontSize:13, color:C.textSub, fontFamily:F, marginTop:8, fontVariantNumeric:"tabular-nums"}}>
                Range {$(comps.estimate.rentRangeLow)} – {$(comps.estimate.rentRangeHigh)}/mo
                {avg > 0 && <> · Avg of {comps.listings.length} listings: <b style={{color:C.text, fontWeight:600}}>{$(avg)}</b></>}
              </div>
            </Card>
          )}
          {comps.listings?.length > 0 ? (
            <div>
              <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14}}>
                <div style={{fontSize:12, fontWeight:600, color:C.textSub, fontFamily:F, letterSpacing:".03em", textTransform:"uppercase"}}>
                  Active listings
                </div>
                <span style={{fontSize:12, color:C.textMuted, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>{comps.listings.length} found</span>
              </div>
              <div style={{display:"grid", gridTemplateColumns:mobile?"1fr":"repeat(auto-fill,minmax(280px,1fr))", gap:14}}>
                {comps.listings.map((l,i) => {
                  const rent = l.price||l.rent||0;
                  const img  = l.photoUrl||(l.photos?.[0]?.url)||null;
                  return (
                    <Card key={l.id||i} hover padding={0}>
                      <div style={{height:170, background:C.bgSubtle, position:"relative"}}>
                        {img
                          ? <img src={img} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} onError={e=>{e.target.style.display="none";}} />
                          : (l.latitude&&l.longitude)
                            ? <img src={svUrl(l.latitude,l.longitude,800,340)} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} />
                            : <div style={{height:"100%", display:"flex", alignItems:"center", justifyContent:"center", color:C.textMuted}}>
                                <I.building size={28}/>
                              </div>
                        }
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
    </div>
  );
}

// -- Settings ------------------------------------------------------------------
function SettingsPage({llcs, renoRates, onSave, onSignOut, mobile, userEmail, lookupsUsed=0, rentcastKey=""}) {
  const [llcTxt,setLlcTxt] = useState(llcs.join("\n"));
  const [rates,setRates]   = useState({...renoRates});
  const [saved,setSaved]   = useState(false);
  const save = () => {
    onSave(llcTxt.split("\n").map(s=>s.trim()).filter(Boolean), rates);
    setSaved(true); setTimeout(()=>setSaved(false), 2000);
  };
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
      <SectionBlock title="Data provider" color={C.green}>
        <div style={{background:C.greenSubtle, border:"1px solid "+C.greenBorder, borderRadius:C.r3, padding:"12px 14px",
          display:"flex", alignItems:"flex-start", gap:10}}>
          <div style={{width:28, height:28, borderRadius:C.r2, background:"#fff",
            border:"1px solid "+C.greenBorder, color:C.greenDark, flexShrink:0,
            display:"flex", alignItems:"center", justifyContent:"center"}}><I.check size={15}/></div>
          <div style={{flex:1, minWidth:0}}>
            <div style={{display:"flex", alignItems:"center", gap:8, flexWrap:"wrap"}}>
              <div style={{fontWeight:600, color:C.text, fontSize:14, fontFamily:F, letterSpacing:"-0.005em"}}>RentCast</div>
              {rentcastKey
                ? <Badge label="Connected" bg={C.greenLight} c={C.greenDark} dot/>
                : <Badge label="Add your key" bg={C.amberSubtle} c={C.amberDark} dot/>}
            </div>
            <div style={{fontSize:12, color:C.textSub, fontFamily:F, marginTop:3, lineHeight:1.5}}>
              Powers everything — property details, tax records, home values, rent estimates and lease comps · 140M+ U.S. properties. Add your key on the Lease Comps page.
            </div>
          </div>
        </div>
      </SectionBlock>
      <SectionBlock title="Property lookups" color={C.green}>
        {(() => {
          const pct = Math.min(100, Math.round((lookupsUsed / LOOKUP_CAP) * 100));
          const barColor = lookupsUsed >= LOOKUP_CAP ? C.red : lookupsUsed >= LOOKUP_CAP*0.8 ? C.amber : C.green;
          return (
            <>
              <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:8}}>
                <span style={{fontSize:13, color:C.text, fontFamily:F, fontWeight:600}}>Used this month</span>
                <span style={{fontSize:13, color:C.textSub, fontFamily:F, fontVariantNumeric:"tabular-nums"}}>
                  {lookupsUsed} / {LOOKUP_CAP}
                </span>
              </div>
              <div style={{height:8, borderRadius:9999, background:C.bgSubtle, overflow:"hidden"}}>
                <div style={{height:"100%", width:pct+"%", background:barColor, borderRadius:9999, transition:"width .25s"}}/>
              </div>
              <p style={{fontSize:12, color:C.textMuted, fontFamily:F, margin:"10px 0 0", lineHeight:1.5}}>
                Each new address you analyze counts as one lookup. Re-opening an address you've already
                pulled is free. Resets on the 1st of each month.
              </p>
            </>
          );
        })()}
      </SectionBlock>
      <SectionBlock title="Repair cost rates" color={C.green}>
        <p style={{fontSize:12, color:C.textMuted, fontFamily:F, margin:"0 0 12px", lineHeight:1.5}}>
          Used by the repair estimator. Adjust to your local market.
        </p>
        <div style={{display:"grid", gridTemplateColumns:mobile?"1fr":"1fr 1fr 1fr", gap:12}}>
          <InputField label="Light reno" val={rates.light} set={v=>setRates(x=>({...x,light:v}))} pre="$" suf="/sqft" mobile={mobile} />
          <InputField label="Medium reno" val={rates.medium} set={v=>setRates(x=>({...x,medium:v}))} pre="$" suf="/sqft" mobile={mobile} />
          <InputField label="Full reno" val={rates.full} set={v=>setRates(x=>({...x,full:v}))} pre="$" suf="/sqft" mobile={mobile} />
        </div>
      </SectionBlock>
      <SectionBlock title="Your LLCs" color={C.green}>
        <p style={{fontSize:12, color:C.textMuted, fontFamily:F, margin:"0 0 10px", lineHeight:1.5}}>
          One LLC per line. Properties can be assigned to any of these.
        </p>
        <textarea value={llcTxt} onChange={e=>setLlcTxt(e.target.value)}
          style={{...iS(mobile), minHeight:130, resize:"vertical", lineHeight:1.55,
            fontFamily:'"JetBrains Mono", ui-monospace, monospace', fontSize:13}} />
      </SectionBlock>
      <SectionBlock title="About" color={C.green}>
        {[["Product","DealHive"], ["Version", "v"+VERSION], ["Website","dealhive.io"],
          ["Default closing costs", "$"+DEFAULT_CLOSING.toLocaleString()],
          ["Default vacancy rate", "5%"]].map(([l,v]) => (
          <DataRow key={l} label={l} value={v} />
        ))}
      </SectionBlock>
      <button onClick={save} {...btnStyle(saved?"secondary":"primary","lg", {width:"100%"})}>
        {saved ? <><I.check size={14}/> Saved</> : "Save settings"}
      </button>
    </div>
  );
}

// -- Add Property Modal --------------------------------------------------------
function AddPropertyModal({llcs, onAdd, onClose, renoRates, mobile, apiLookup, rentcastKey}) {
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
    if (!rentcastKey) { setErr("Add your RentCast API key first — paste it on the Lease Comps page."); return; }
    setL(true); setErr("");
    try {
      const key = lookupKey("rc-detail", addr, city, state, zip);
      const data = await apiLookup(key, () => rentcastFetch(addr, city, state, zip, rentcastKey));
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
    ? {background:C.card, borderRadius:"18px 18px 0 0", width:"100%", maxHeight:"92dvh", overflowY:"auto",
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
const NAV_ITEMS = [
  {id:"dashboard",  Icon:I.home,           label:"Dashboard"},
  {id:"properties", Icon:I.building,       label:"Properties"},
  {id:"projects",   Icon:I.clipboardCheck, label:"Projects"},
  {id:"deal",       Icon:I.search,         label:"Deal Analyzer"},
  {id:"comps",      Icon:I.chart,          label:"Lease Comps"},
  {id:"settings",   Icon:I.settings,       label:"Settings"},
];

function DesktopSidebar({page, setPage, daysLeft, userEmail}) {
  return (
    <div style={{width:230, background:C.sidebar, height:"100vh", position:"fixed",
      left:0, top:0, display:"flex", flexDirection:"column", zIndex:100,
      borderRight:"1px solid rgba(255,255,255,.06)"}}>
      <div style={{background:"#fff", padding:"11px 20px 10px", display:"flex", alignItems:"center", justifyContent:"center", borderBottom:"2px solid "+C.green}}>
        <img src="/logo.png" alt="DealHive" style={{display:"block", width:"100%", maxWidth:185, height:"auto", objectFit:"contain"}} />
      </div>
      <div style={{flex:1, padding:"6px 10px", overflowY:"auto"}}>
        {NAV_ITEMS.map(item => {
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
function MobileNav({page, setPage, alertCount}) {
  const tabs = [
    {id:"dashboard",  Icon:I.home,           label:"Home"},
    {id:"properties", Icon:I.building,       label:"Props"},
    {id:"projects",   Icon:I.clipboardCheck, label:"Projects"},
    {id:"deal",       Icon:I.search,         label:"Analyze"},
    {id:"comps",      Icon:I.chart,          label:"Comps"},
    {id:"settings",   Icon:I.settings,       label:"More"},
  ];
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
function MobileHeader({page, onBack, toast}) {
  const showBack = page==="property";
  const titles = {
    dashboard:"Portfolio", properties:"Properties", projects:"Projects",
    deal:"Deal Analyzer", comps:"Lease Comps",
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
function DesktopTopBar({page, propAddress, toast}) {
  const titles = {
    dashboard:"Dashboard", properties:"Properties", projects:"Projects",
    deal:"Deal Analyzer", comps:"Lease Comps",
    settings:"Settings", property:propAddress||"Property"
  };
  return (
    <div style={{background:"#ffffff", borderBottom:"1px solid "+C.border,
      padding:"0 32px", height:56, display:"flex", alignItems:"center", justifyContent:"space-between",
      position:"sticky", top:0, zIndex:100}}>
      <div style={{fontSize:14, fontWeight:600, color:C.text, fontFamily:F, letterSpacing:"-0.01em"}}>
        {titles[page]||"DealHive"}
      </div>
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
  const [page,   setPage]   = useState("dashboard");
  const [propId, setPropId] = useState(null);
  const [showAdd,setShowAdd]= useState(false);
  const [toast,  setToast]  = useState("");
  const [daysLeft,setDL]    = useState(null);
  const [authLoading,setAL] = useState(true);
  const mobile = useIsMobile();

  // Body scroll lock — class-based. Toggling a class is far more robust
  // than mutating body.style.overflow: classList.add/remove can't get
  // stuck in a half-state under React Strict Mode, fast-clicked modal
  // sequences, or Safari quirks. The .dh-scroll-locked rule is injected
  // below alongside the rest of the global styles.
  useEffect(() => {
    document.body.classList.toggle("dh-scroll-locked", showAdd);
    return () => document.body.classList.remove("dh-scroll-locked");
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
      body.dh-scroll-locked{overflow:hidden;}
      img{max-width:100%;height:auto;}
      input,select,textarea,button{font-family:inherit;}
      /* Prevent iOS from auto-zooming when focusing inputs — needs font-size >= 16px on the input. iS() already sets 16 on mobile, this is a safety net. */
      @media (max-width:767px){input,select,textarea{font-size:16px!important;}}
      input::placeholder,textarea::placeholder{color:${C.textMuted};}
      input,select,textarea{transition:border-color .15s,box-shadow .15s;}
      input:focus,select:focus,textarea:focus{border-color:${C.green}!important;box-shadow:${C.ring}!important;}
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
    setUser(u); saveAuth(u);
    let meta = await loadMeta(u.localId, u.idToken);
    if (!meta || isNew) {
      meta = {createdAt:new Date().toISOString(), trialStart:new Date().toISOString()};
      await saveMeta(u.localId, u.idToken, meta);
    }
    const dl = Math.ceil((new Date(meta.trialStart).getTime() + TRIAL_DAYS*86400000 - Date.now()) / 86400000);
    setDL(dl);
    const saved = await loadData(u.localId, u.idToken);
    setData(saved || {...SEED});
    setAL(false);
    if (!silent) { setToast("Welcome to DealHive! 🐝"); setTimeout(()=>setToast(""), 3000); }
  };

  const handleSignOut = () => { clearAuth(); setUser(null); setData(null); setPage("dashboard"); setPropId(null); };

  const persist = useCallback((next) => {
    setData(next);
    if (user) saveData(user.localId, user.idToken, next);
    setToast("Saved OK"); setTimeout(()=>setToast(""), 1600);
  }, [user]);

  // Quiet persist — used for cache/usage bookkeeping so it doesn't flash a
  // "Saved OK" toast on every API lookup.
  const persistQuiet = useCallback((next) => {
    setData(next);
    if (user) saveData(user.localId, user.idToken, next);
  }, [user]);

  // Lookups used this calendar month (resets automatically when the month rolls).
  const lookupsUsed = (data && data.usage && data.usage.month === monthKey())
    ? (data.usage.count || 0) : 0;

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

  // Loading screen
  if (authLoading) return (
    <div style={{minHeight:"100vh", background:C.bg,
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16}}>
      <img src="/logo.png" alt="DealHive" style={{height:46, width:"auto", maxWidth:"70%", objectFit:"contain"}} />
      <div style={{fontSize:13, color:C.textMuted, fontFamily:F}}>Loading your portfolio…</div>
    </div>
  );

  // Auth screen
  if (!user || !data) return <AuthPage onAuth={handleAuth} />;

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

  const alerts     = (data.properties||[]).filter(p => {
    const d = dU(p.leaseEnd);
    return p.tenantStatus==="Late" || (d!=null && d<=60 && d>=0);
  }).length;
  const activeProp = (data.properties||[]).find(p => p.id===propId);
  const showProp   = !!propId && !!activeProp;
  const effPage    = showProp ? "property" : page;

  const sharedProps = {
    renoRates: data.renoRates || SEED.renoRates,
    mobile,
    apiLookup,
    rentcastKey: data.rentcastKey || "",
  };

  // Mobile layout
  if (mobile) return (
    <div style={{fontFamily:F, background:C.bg, minHeight:"100vh", width:"100%", maxWidth:600, margin:"0 auto", overflowX:"clip"}}>
      <MobileHeader page={effPage} onBack={()=>setPropId(null)} toast={toast} daysLeft={daysLeft} />
      <TrialBanner daysLeft={daysLeft} />
      <ErrorBoundary>
        {showProp ? (
          <PropertyDetail prop={activeProp} onBack={()=>setPropId(null)}
            onChange={updateProp} onDelete={delProp} llcs={data.llcs||[]} {...sharedProps} />
        ) : page==="dashboard" ? (
          <Dashboard properties={data.properties||[]} onSelect={id=>setPropId(id)} onAdd={()=>setShowAdd(true)} mobile={mobile} />
        ) : page==="properties" ? (
          <MyProperties properties={data.properties||[]} onSelect={id=>setPropId(id)} onAdd={()=>setShowAdd(true)} onDelete={delProp} mobile={mobile} />
        ) : page==="projects" ? (
          <ProjectsPage properties={data.properties||[]} onUpdateProperty={updateProp} mobile={mobile} />
        ) : page==="deal" ? (
          <DealAnalyzer deals={data.deals||[]} onSave={saveDeals} onMoveToPortfolio={moveDealToPortfolio} {...sharedProps} />
        ) : page==="comps" ? (
          <LeaseComps rentcastKey={data.rentcastKey||""} onSaveKey={saveRCKey} mobile={mobile} apiLookup={apiLookup} />
        ) : page==="settings" ? (
          <SettingsPage llcs={data.llcs||[]} renoRates={data.renoRates||SEED.renoRates}
            onSave={(l,r)=>persist({...data,llcs:l,renoRates:r})}
            onSignOut={handleSignOut} mobile={mobile} userEmail={user.email} lookupsUsed={lookupsUsed} rentcastKey={data.rentcastKey||""} />
        ) : null}
      </ErrorBoundary>
      <MobileNav page={showProp?"dashboard":page} setPage={p=>{setPage(p);setPropId(null);}} alertCount={alerts} />
      {showAdd && <AddPropertyModal llcs={data.llcs||[]} onAdd={addProp} onClose={()=>setShowAdd(false)} {...sharedProps} />}
    </div>
  );

  // Desktop layout
  return (
    <div style={{fontFamily:F, background:C.bg, minHeight:"100vh", display:"flex"}}>
      <DesktopSidebar page={showProp?"properties":page} setPage={p=>{setPage(p);setPropId(null);}} daysLeft={daysLeft} userEmail={user.email} />
      <div style={{marginLeft:230, flex:1, minWidth:0}}>
        <DesktopTopBar page={effPage} propAddress={activeProp?.address} toast={toast} />
        <TrialBanner daysLeft={daysLeft} />
        <div style={{maxWidth:1200, margin:"0 auto"}}>
          <ErrorBoundary>
            {showProp ? (
              <PropertyDetail prop={activeProp} onBack={()=>setPropId(null)}
                onChange={updateProp} onDelete={delProp} llcs={data.llcs||[]} {...sharedProps} />
            ) : page==="dashboard" ? (
              <Dashboard properties={data.properties||[]} onSelect={id=>setPropId(id)} onAdd={()=>setShowAdd(true)} mobile={mobile} />
            ) : page==="properties" ? (
              <MyProperties properties={data.properties||[]} onSelect={id=>setPropId(id)} onAdd={()=>setShowAdd(true)} onDelete={delProp} mobile={mobile} />
            ) : page==="projects" ? (
              <ProjectsPage properties={data.properties||[]} onUpdateProperty={updateProp} mobile={mobile} />
            ) : page==="deal" ? (
              <DealAnalyzer deals={data.deals||[]} onSave={saveDeals} onMoveToPortfolio={moveDealToPortfolio} {...sharedProps} />
            ) : page==="comps" ? (
              <LeaseComps rentcastKey={data.rentcastKey||""} onSaveKey={saveRCKey} mobile={mobile} apiLookup={apiLookup} />
            ) : page==="settings" ? (
              <SettingsPage llcs={data.llcs||[]} renoRates={data.renoRates||SEED.renoRates}
                onSave={(l,r)=>persist({...data,llcs:l,renoRates:r})}
                onSignOut={handleSignOut} mobile={mobile} userEmail={user.email} lookupsUsed={lookupsUsed} rentcastKey={data.rentcastKey||""} />
            ) : null}
          </ErrorBoundary>
        </div>
      </div>
      {showAdd && <AddPropertyModal llcs={data.llcs||[]} onAdd={addProp} onClose={()=>setShowAdd(false)} {...sharedProps} />}
    </div>
  );
}
