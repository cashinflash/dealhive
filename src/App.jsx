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
const ATTOM_API_KEY  = "b6c4b22c6bd0c366f37068f3a41621b1";
const ATTOM_BASE     = "https://api.gateway.attomdata.com/propertyapi/v1.0.0";
const TRIAL_DAYS     = 7;
const VERSION        = "1.0.0";
const DEFAULT_CLOSING = 10895;

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
const F   = "'Inter', -apple-system, sans-serif";
const $   = n  => "$" + Math.round(n||0).toLocaleString();
const $mo = n  => { const r = Math.round(n||0); return (r<0?"-$":"$") + Math.abs(r).toLocaleString() + "/mo"; };
const pct = n  => (isNaN(n)?0:(n||0)).toFixed(2) + "%";
const cfC = v  => v>0 ? "#10b981" : v<0 ? "#ef4444" : "#6b7280";
const dU  = d  => { if(!d) return null; return Math.ceil((new Date(d)-new Date())/86400000); };
const obBadge = p => p.occupied ? {label:"Occupied",bg:"#d1fae5",c:"#065f46"} : {label:"Vacant",bg:"#f3f4f6",c:"#6b7280"};
const stStyle = s => s==="Current"?{bg:"#d1fae5",c:"#065f46"}:s==="Late"?{bg:"#fee2e2",c:"#dc2626"}:s==="Partial"?{bg:"#fff7ed",c:"#ea580c"}:{bg:"#f3f4f6",c:"#6b7280"};
const svUrl   = (lat,lng,w=800,h=400) => "https://maps.googleapis.com/maps/api/streetview?size="+w+"x"+h+"&location="+lat+","+lng+"&fov=90&pitch=0&key="+GOOGLE_API_KEY;

const newProp = (base={}) => ({
  id:"p"+Date.now(), address:"", city:"", state:"", zip:"", lat:null, lng:null,
  llc:"My LLC", type:"Single Family", beds:3, baths:1, sqft:0, yearBuilt:2000,
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

// -- Design System -------------------------------------------------------------
const C = {
  green:"#10b981", greenDark:"#065f46", greenLight:"#d1fae5", greenMid:"#059669",
  sidebar:"#111827", sidebarHover:"#1f2937",
  bg:"#f9fafb", card:"#ffffff", border:"#e5e7eb",
  text:"#111827", textSub:"#6b7280", textMuted:"#9ca3af",
  blue:"#3b82f6", amber:"#f59e0b", red:"#ef4444", purple:"#7c3aed",
};

const iS = (mobile=false) => ({
  width:"100%", border:"1px solid "+C.border, borderRadius:8,
  padding: mobile ? "12px 14px" : "9px 12px",
  fontSize: mobile ? 16 : 14,
  outline:"none", background:"white", boxSizing:"border-box",
  fontFamily:F, color:C.text, WebkitTextFillColor:C.text,
});

const btnStyle = (variant="primary", size="md", extra={}) => {
  const v = {
    primary:  {background:C.green,    color:"white",   border:"none"},
    secondary:{background:"white",    color:C.text,    border:"1px solid "+C.border},
    danger:   {background:"#fee2e2",  color:C.red,     border:"1px solid #fca5a5"},
    ghost:    {background:"transparent", color:C.textSub, border:"none"},
    blue:     {background:C.blue,     color:"white",   border:"none"},
    dark:     {background:C.sidebar,  color:"white",   border:"none"},
  };
  const s = {
    sm:  {padding:"5px 12px",  fontSize:12, borderRadius:6},
    md:  {padding:"8px 16px",  fontSize:14, borderRadius:8},
    lg:  {padding:"11px 22px", fontSize:15, borderRadius:10},
    xl:  {padding:"13px 28px", fontSize:15, borderRadius:10},
  };
  return { ...v[variant], ...s[size], cursor:"pointer", fontWeight:600, fontFamily:F,
    display:"inline-flex", alignItems:"center", justifyContent:"center", gap:6,
    transition:"all .15s", WebkitTapHighlightColor:"transparent", ...extra };
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

// -- ATTOM ---------------------------------------------------------------------
const attomFetch = async (addr, city, state, zip) => {
  const a1 = encodeURIComponent(addr);
  const a2 = encodeURIComponent(city+" "+state+" "+zip);
  const h  = {"apikey":ATTOM_API_KEY, "Accept":"application/json"};
  const out = {};
  try { const r=await fetch(ATTOM_BASE+"/allevents/detail?address1="+a1+"&address2="+a2,{headers:h}); const d=await r.json(); if(d?.property?.[0]) out.property=d.property[0]; } catch {}
  try { const r=await fetch(ATTOM_BASE+"/avm/detail?address1="+a1+"&address2="+a2,{headers:h}); const d=await r.json(); if(d?.property?.[0]?.avm) out.avm=d.property[0].avm; } catch {}
  try { const r=await fetch(ATTOM_BASE+"/valuation/rentalavm?address1="+a1+"&address2="+a2,{headers:h}); const d=await r.json(); if(d?.property?.[0]) out.rental=d.property[0]; } catch {}
  return out;
};

const applyAttom = (prev, data, rates) => {
  const p   = data.property || {};
  const bld = p.building || {};
  const loc = p.location  || {};
  const asr = p.assessment || {};
  const tax    = asr.tax?.taxamt || 0;
  const taxVal = asr.assessed?.assdttlvalue || 0;
  const sqft   = bld.size?.universalsize || bld.size?.livingsize || prev.sqft || 0;
  const avm    = data.avm || {};
  const med    = avm.amount?.value || prev.homeValueMedian || 0;
  const lo     = avm.amount?.low   || Math.round(med * 0.9);
  const hi     = avm.amount?.high  || Math.round(med * 1.1);
  const rental = data.rental || {};
  const rentEst     = rental.avm?.rentalvalue    || prev.rentEstimate || 0;
  const rentEstLow  = rental.avm?.rentallowvalue  || Math.round(rentEst * 0.9);
  const rentEstHigh = rental.avm?.rentalhighvalue || Math.round(rentEst * 1.1);
  const r = rates || {light:7, medium:13, full:45};
  return {
    ...prev,
    beds:      bld.rooms?.beds           || prev.beds,
    baths:     bld.rooms?.bathstotal     || prev.baths,
    sqft,
    yearBuilt: bld.summary?.yearbuilt    || prev.yearBuilt,
    taxValue:  taxVal,
    parcelId:  p.identifier?.apn         || prev.parcelId,
    lat:       parseFloat(loc.latitude)  || prev.lat,
    lng:       parseFloat(loc.longitude) || prev.lng,
    type:      p.summary?.proptype       || prev.type,
    expPropTax: tax ? Math.round(tax/12) : (taxVal ? Math.round(taxVal*0.024/12) : prev.expPropTax),
    homeValueMedian: med, homeValueLow: lo, homeValueHigh: hi,
    flipSalePrice: hi || prev.flipSalePrice,
    brrrCashOut:   Math.round(med * 0.8),
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

// -- UI Primitives -------------------------------------------------------------
function Card({children, style={}, onClick, onMouseEnter, onMouseLeave}) {
  return (
    <div onClick={onClick} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
      style={{background:C.card, borderRadius:12, border:"1px solid "+C.border,
        boxShadow:"0 1px 4px rgba(0,0,0,.05)", overflow:"hidden", ...style}}>
      {children}
    </div>
  );
}

function PageHeader({title, subtitle, action}) {
  return (
    <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:24}}>
      <div>
        <h1 style={{margin:0, fontSize:22, fontWeight:800, color:C.text, fontFamily:F}}>{title}</h1>
        {subtitle && <p style={{margin:"4px 0 0", fontSize:14, color:C.textSub, fontFamily:F}}>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

function StatCard({label, value, sub, color, icon}) {
  return (
    <Card style={{padding:18}}>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start"}}>
        <div>
          <div style={{fontSize:11, color:C.textMuted, fontWeight:600, textTransform:"uppercase", letterSpacing:".06em", fontFamily:F, marginBottom:6}}>{label}</div>
          <div style={{fontSize:22, fontWeight:800, color:color||C.text, fontFamily:F, lineHeight:1}}>{value}</div>
          {sub && <div style={{fontSize:12, color:C.textSub, marginTop:4, fontFamily:F}}>{sub}</div>}
        </div>
        {icon && <div style={{fontSize:26, opacity:.8}}>{icon}</div>}
      </div>
    </Card>
  );
}

function SectionBlock({title, color=C.green, children, right, collapsible=false, defaultOpen=true}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{border:"1px solid "+color+"25", borderRadius:12, overflow:"hidden", marginBottom:14}}>
      <div style={{background:color, padding:"10px 16px", display:"flex", justifyContent:"space-between", alignItems:"center",
        cursor: collapsible ? "pointer" : "default"}}
        onClick={collapsible ? ()=>setOpen(o=>!o) : undefined}>
        <span style={{color:"white", fontWeight:700, fontSize:12, textTransform:"uppercase", letterSpacing:".06em", fontFamily:F}}>{title}</span>
        <div style={{display:"flex", gap:8, alignItems:"center"}}>
          {right}
          {collapsible && <span style={{color:"white", fontSize:16, lineHeight:1, transition:"transform .2s", display:"block", transform:open?"rotate(180deg)":"none"}}>v</span>}
        </div>
      </div>
      {open && <div style={{background:"white", padding:16}}>{children}</div>}
    </div>
  );
}

function DataRow({label, value, color}) {
  return (
    <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", padding:"7px 0", borderBottom:"1px solid "+C.bg}}>
      <span style={{fontSize:13, color:C.textSub, fontFamily:F}}>{label}</span>
      <span style={{fontSize:13, fontWeight:600, color:color||C.text, fontFamily:F}}>{value}</span>
    </div>
  );
}

// FIXED: clear field on focus so typing replaces 0
function InputField({label, val, set, type="number", suf, pre, note, mobile=false}) {
  const handleFocus = e => {
    if (type === "number" && (e.target.value === "0" || e.target.value === "0.00")) {
      e.target.select();
    }
  };
  return (
    <div style={{marginBottom:12}}>
      <div style={{display:"flex", justifyContent:"space-between", marginBottom:5}}>
        <label style={{fontSize:13, color:C.textSub, fontWeight:500, fontFamily:F}}>{label}</label>
        {note && <span style={{fontSize:11, color:C.textMuted, fontFamily:F}}>{note}</span>}
      </div>
      <div style={{display:"flex", alignItems:"center", gap:6}}>
        {pre && <span style={{fontSize:14, color:C.textMuted, fontFamily:F, flexShrink:0}}>{pre}</span>}
        <input type={type} value={val}
          inputMode={type==="number" ? "decimal" : undefined}
          onFocus={handleFocus}
          onChange={e => set(type==="number" ? parseFloat(e.target.value)||0 : e.target.value)}
          style={{...iS(mobile), flex:1}} />
        {suf && <span style={{fontSize:14, color:C.textMuted, fontFamily:F, flexShrink:0}}>{suf}</span>}
      </div>
    </div>
  );
}

function Badge({label, bg, c}) {
  return <span style={{background:bg, color:c, padding:"3px 10px", borderRadius:20, fontSize:12, fontWeight:600, fontFamily:F, whiteSpace:"nowrap"}}>{label}</span>;
}

function StreetViewImg({lat, lng, address, height=200}) {
  if (!lat || !lng) return null;
  return (
    <div style={{position:"relative", borderRadius:12, overflow:"hidden", marginBottom:16}}>
      <img src={svUrl(lat,lng,900,height*2)} alt="Street View"
        style={{width:"100%", height, objectFit:"cover", display:"block"}} />
      <div style={{position:"absolute", inset:0, background:"linear-gradient(to bottom,transparent 50%,rgba(0,0,0,.7))"}} />
      <div style={{position:"absolute", bottom:12, left:14, right:14, display:"flex", justifyContent:"space-between", alignItems:"flex-end"}}>
        <div style={{color:"white", fontWeight:700, fontSize:14, fontFamily:F}}>{address}</div>
        <a href={"https://maps.google.com/?q="+lat+","+lng} target="_blank" rel="noreferrer"
          style={{background:"rgba(255,255,255,.9)", color:C.text, padding:"4px 10px", borderRadius:8, fontSize:12, fontWeight:600, textDecoration:"none", fontFamily:F}}>
          Maps ->
        </a>
      </div>
    </div>
  );
}

function TrialBanner({daysLeft}) {
  if (daysLeft === null || daysLeft > TRIAL_DAYS) return null;
  const expired = daysLeft <= 0;
  return (
    <div style={{background:expired?"#fee2e2":"#fef3c7", borderBottom:"1px solid "+(expired?"#fca5a5":"#fde68a"),
      padding:"10px 20px", display:"flex", justifyContent:"space-between", alignItems:"center"}}>
      <div style={{fontSize:13, fontFamily:F, color:expired?"#dc2626":"#92400e", fontWeight:600}}>
        {expired ? "Your free trial has expired" : "🐝 Free trial: "+daysLeft+" day"+(daysLeft===1?"":"s")+" remaining"}
      </div>
      <button style={btnStyle("primary","sm")}>{expired ? "Renew Now" : "Upgrade to Pro"}</button>
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

  return (
    <div style={{minHeight:"100vh", background:"linear-gradient(135deg,"+C.sidebar+" 0%,#1f2937 100%)",
      display:"flex", alignItems:"center", justifyContent:"center", padding:20}}>
      <div style={{width:"100%", maxWidth:420}}>
        <div style={{textAlign:"center", marginBottom:32}}>
          <div style={{display:"inline-flex", alignItems:"center", gap:10, marginBottom:8}}>
            <div style={{width:44, height:44, background:C.green, borderRadius:12,
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:24}}>🐝</div>
            <div style={{fontSize:32, fontWeight:900, color:"white", fontFamily:F, letterSpacing:"-.02em"}}>
              Deal<span style={{color:C.amber}}>Hive</span>
            </div>
          </div>
          <div style={{fontSize:14, color:"rgba(255,255,255,.6)", fontFamily:F}}>Real Estate Investment Platform</div>
        </div>
        <Card style={{padding:32, borderRadius:16}}>
          <h2 style={{margin:"0 0 4px", fontSize:20, fontWeight:800, color:C.text, fontFamily:F}}>
            {mode==="signin" ? "Welcome back" : mode==="signup" ? "Start your free trial" : "Reset password"}
          </h2>
          <p style={{margin:"0 0 24px", fontSize:14, color:C.textSub, fontFamily:F}}>
            {mode==="signin"  ? "Sign in to your DealHive account" :
             mode==="signup"  ? TRIAL_DAYS+" days free - no credit card needed" :
             "We'll send you a reset link"}
          </p>
          {err && <div style={{background:"#fee2e2", border:"1px solid #fca5a5", borderRadius:8, padding:"10px 14px", marginBottom:16, fontSize:13, color:C.red, fontFamily:F}}>{err}</div>}
          {msg && <div style={{background:C.greenLight, border:"1px solid #6ee7b7", borderRadius:8, padding:"10px 14px", marginBottom:16, fontSize:13, color:C.greenDark, fontFamily:F}}>{msg}</div>}
          <form onSubmit={submit}>
            <div style={{marginBottom:14}}>
              <label style={{fontSize:13, color:C.textSub, fontWeight:500, display:"block", marginBottom:5, fontFamily:F}}>Email address</label>
              <input type="email" value={email} onChange={e=>setEmail(e.target.value)} required
                placeholder="you@example.com" style={{...iS(), width:"100%", boxSizing:"border-box"}} />
            </div>
            {mode !== "reset" && (
              <div style={{marginBottom:14}}>
                <label style={{fontSize:13, color:C.textSub, fontWeight:500, display:"block", marginBottom:5, fontFamily:F}}>Password</label>
                <input type="password" value={password} onChange={e=>setPass(e.target.value)} required
                  placeholder="********" style={{...iS(), width:"100%", boxSizing:"border-box"}} />
              </div>
            )}
            {mode === "signup" && (
              <div style={{marginBottom:14}}>
                <label style={{fontSize:13, color:C.textSub, fontWeight:500, display:"block", marginBottom:5, fontFamily:F}}>Confirm Password</label>
                <input type="password" value={confirm} onChange={e=>setConf(e.target.value)} required
                  placeholder="********" style={{...iS(), width:"100%", boxSizing:"border-box"}} />
              </div>
            )}
            {mode === "signin" && (
              <div style={{textAlign:"right", marginBottom:16}}>
                <button type="button" onClick={()=>{setMode("reset");setErr("");}}
                  style={{background:"none", border:"none", color:C.green, fontSize:13, cursor:"pointer", fontFamily:F}}>
                  Forgot password?
                </button>
              </div>
            )}
            <button type="submit" disabled={loading}
              style={{...btnStyle("primary","lg"), width:"100%", marginBottom:12, opacity:loading?.7:1}}>
              {loading ? "Please wait..." :
               mode==="signin"  ? "Sign In" :
               mode==="signup"  ? "Start Free Trial ->" : "Send Reset Email"}
            </button>
          </form>
          <div style={{textAlign:"center", fontSize:13, color:C.textSub, fontFamily:F}}>
            {mode==="signin" ? (
              <>No account? <button onClick={()=>{setMode("signup");setErr("");}}
                style={{background:"none",border:"none",color:C.green,fontWeight:700,cursor:"pointer",fontFamily:F,fontSize:13}}>Sign up free</button></>
            ) : mode==="signup" ? (
              <>Already have an account? <button onClick={()=>{setMode("signin");setErr("");}}
                style={{background:"none",border:"none",color:C.green,fontWeight:700,cursor:"pointer",fontFamily:F,fontSize:13}}>Sign in</button></>
            ) : (
              <button onClick={()=>{setMode("signin");setErr("");}}
                style={{background:"none",border:"none",color:C.green,fontWeight:700,cursor:"pointer",fontFamily:F,fontSize:13}}><- Back to sign in</button>
            )}
          </div>
        </Card>
        <div style={{textAlign:"center", marginTop:20, fontSize:12, color:"rgba(255,255,255,.4)", fontFamily:F}}>
          (c) 2025 DealHive - dealhive.io
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
      const ob = obBadge(p);
      const icon = L.divIcon({className:"", iconSize:[30,30], iconAnchor:[15,15],
        html:'<div style="width:30px;height:30px;background:'+ob.c+';border:3px solid white;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center">'+
          '<svg width="12" height="12" fill="white" viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg></div>'});
      const cf = calc(p).chosenCF;
      const cfStr = (cf<0?"-$":"$")+Math.abs(Math.round(cf)).toLocaleString()+"/mo";
      const popup = '<div style="font-family:Inter,sans-serif;min-width:150px;font-size:13px;padding:4px">'+
        '<b>'+p.address+'</b><br>'+
        '<span style="color:'+cfC(cf)+';font-weight:700">'+cfStr+'</span><br><br>'+
        '<button onclick="window.__dhOpen(\''+p.id+'\')" style="background:#10b981;color:white;border:none;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;width:100%">Open -></button>'+
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
    <SectionBlock title="📈 Value Appreciation Projector" color="#0891b2" collapsible defaultOpen={false}>
      <div style={{marginBottom:14}}>
        <label style={{fontSize:13,color:C.textSub,fontWeight:500,display:"block",marginBottom:6,fontFamily:F}}>
          Annual appreciation rate: <b>{rate}%</b>
        </label>
        <input type="range" min={0} max={10} step={0.5} value={rate}
          onChange={e=>setRate(parseFloat(e.target.value))}
          style={{width:"100%", accentColor:C.green}} />
        <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:C.textMuted,fontFamily:F}}>
          <span>0%</span><span>5%</span><span>10%</span>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:mobile?"1fr 1fr":"repeat(5,1fr)",gap:10}}>
        {years.map(yr => {
          const val = base * Math.pow(1 + rate/100, yr);
          const gain = val - base;
          return (
            <div key={yr} style={{background:C.bg,borderRadius:10,padding:"10px 12px",textAlign:"center"}}>
              <div style={{fontSize:11,color:C.textMuted,fontFamily:F,marginBottom:4}}>{yr} yr{yr>1?"s":""}</div>
              <div style={{fontSize:14,fontWeight:700,color:C.text,fontFamily:F}}>{$(val)}</div>
              <div style={{fontSize:11,color:C.green,fontFamily:F,marginTop:2}}>+{$(gain)}</div>
            </div>
          );
        })}
      </div>
      <div style={{marginTop:10,fontSize:12,color:C.textMuted,fontFamily:F}}>
        Based on current value of {$(base)}. Appreciation is not guaranteed.
      </div>
    </SectionBlock>
  );
}

// -- Calculator ----------------------------------------------------------------
function Calculator({p, set, renoRates={light:7,medium:13,full:45}, mobile}) {
  const u   = (f,v) => set({...p, [f]:v});
  const m   = calc(p);
  const s   = p.chosenStrategy || "finance";

  return (
    <div>
      {/* Strategy toggle */}
      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:16}}>
        {[["cash","All Cash","#b45309"],["finance","Financed",C.green]].map(([id,label,color]) => (
          <button key={id} onClick={()=>u("chosenStrategy",id)}
            style={{padding:12, borderRadius:10, border:"2px solid "+(s===id?color:C.border),
              background:s===id?color:"white", color:s===id?"white":C.textSub,
              fontWeight:700, fontSize:14, cursor:"pointer", fontFamily:F, transition:"all .15s"}}>
            {s===id?"":""}{label}
          </button>
        ))}
      </div>

      {/* Rent estimate banner */}
      {p.rentEstimate > 0 && (
        <div style={{background:"linear-gradient(135deg,#0891b2,#0e7490)", borderRadius:12, padding:16, marginBottom:16, color:"white"}}>
          <div style={{fontSize:11, fontWeight:700, textTransform:"uppercase", opacity:.8, fontFamily:F}}>📊 Market Rent Estimate</div>
          <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:6, flexWrap:"wrap", gap:10}}>
            <div>
              <div style={{fontSize:26, fontWeight:900, fontFamily:F}}>{$(p.rentEstimate)}/mo</div>
              <div style={{fontSize:12, opacity:.8, fontFamily:F}}>{$(p.rentEstLow)} - {$(p.rentEstHigh)} range</div>
            </div>
            <button onClick={()=>u("rentAmount", p.rentEstimate)}
              style={{background:"rgba(255,255,255,.2)", border:"1px solid rgba(255,255,255,.4)",
                borderRadius:8, padding:"7px 14px", color:"white", fontWeight:600, fontSize:13, fontFamily:F, cursor:"pointer"}}>
              Use This Estimate ->
            </button>
          </div>
          {p.rentAmount > 0 && (
            <div style={{fontSize:12, marginTop:6, color:p.rentAmount>=p.rentEstimate?"#86efac":"#fca5a5", fontFamily:F}}>
              Your rent {$(p.rentAmount)}/mo -- {p.rentAmount>=p.rentEstimate?"at or above market":"below market estimate"}
            </div>
          )}
        </div>
      )}

      <div style={{display:"grid", gridTemplateColumns:mobile?"1fr":"1fr 1fr", gap:14}}>

        {/* All Cash */}
        <SectionBlock title="All Cash Purchase" color={s==="cash"?"#b45309":"#9a7e5a"}>
          <InputField label="Purchase Price" val={p.purchasePrice} set={v=>u("purchasePrice",v)} pre="$" mobile={mobile} />
          <InputField label="Repair Costs" val={p.repairCosts} set={v=>u("repairCosts",v)} pre="$" mobile={mobile} />
          <InputField label="Monthly Rent" val={p.rentAmount} set={v=>u("rentAmount",v)} pre="$" mobile={mobile} />
          <InputField label="Vacancy Rate" val={p.vacancyRate||5} set={v=>u("vacancyRate",v)} suf="%" note="5% = ~18 vacant days/yr" mobile={mobile} />
          {(p.vacancyRate||0) > 0 && <DataRow label="Effective Rent /mo" value={$(m.effectiveRent)} color={C.textSub} />}
          <DataRow label="Cash Flow /mo" value={$mo(m.cashCF)} color={cfC(m.cashCF)} />
          <DataRow label="Total Out of Pocket" value={$(m.cashOOP)} />
          <DataRow label="Cash-on-Cash" value={pct(m.cashCoC)} color={cfC(m.cashCoC)} />
          <DataRow label="Cap Rate" value={pct(m.cashCap)} />
        </SectionBlock>

        {/* Finance */}
        <SectionBlock title="Finance Purchase" color={s==="finance"?C.green:"#4a8a6a"}>
          <InputField label="Purchase Price" val={p.purchasePrice} set={v=>u("purchasePrice",v)} pre="$" mobile={mobile} />
          <InputField label="Down Payment" val={p.downPaymentPct} set={v=>u("downPaymentPct",v)} suf="%" mobile={mobile} />
          <InputField label="Interest Rate" val={p.interestRate} set={v=>u("interestRate",v)} suf="%" mobile={mobile} />
          <InputField label="Closing Costs" val={p.closingCosts!=null?p.closingCosts:DEFAULT_CLOSING}
            set={v=>u("closingCosts",v)} pre="$" note={"Def. $"+DEFAULT_CLOSING.toLocaleString()} mobile={mobile} />
          <DataRow label="Down Payment" value={$(m.down)} />
          <DataRow label="Loan Amount" value={$(m.loan)} />
          <DataRow label="Mortgage /mo" value={$mo(m.mtg)} />
          <DataRow label="Cash Flow /mo" value={$mo(m.finCF)} color={cfC(m.finCF)} />
          <DataRow label="Out of Pocket" value={$(m.finOOP)} />
          <div style={{fontSize:11,color:C.textMuted,fontFamily:F,padding:"2px 0 6px"}}>^ Down + Repairs + Closing Costs</div>
          <DataRow label="Cash-on-Cash" value={pct(m.finCoC)} color={cfC(m.finCoC)} />
          <DataRow label="Cap Rate" value={pct(m.finCap)} />
          <DataRow label="Years to Payoff" value={m.payoff>0 ? m.payoff.toFixed(1)+" yrs" : "--"} />
        </SectionBlock>

        {/* Expenses */}
        <SectionBlock title="💰 Monthly Expenses" color="#059669">
          <InputField label="Property Tax /mo" val={p.expPropTax} set={v=>u("expPropTax",v)} pre="$" mobile={mobile} />
          <InputField label="Utilities /mo" val={p.expUtilities} set={v=>u("expUtilities",v)} pre="$" mobile={mobile} />
          <InputField label="Management /mo" val={p.expManagement} set={v=>u("expManagement",v)} pre="$" mobile={mobile} />
          <InputField label="Insurance /mo" val={p.expInsurance} set={v=>u("expInsurance",v)} pre="$" mobile={mobile} />
          <DataRow label="Total Expenses /mo" value={$(m.exp)} />
          <DataRow label="NOI /yr" value={$(m.noi*12)} />
          <DataRow label="Yearly Rent" value={$((p.rentAmount||0)*12)} />
        </SectionBlock>

        {/* BRRR - collapsible */}
        <SectionBlock title="BRRR Estimates" color={C.purple} collapsible defaultOpen={false}>
          <div style={{fontSize:12,color:C.purple,background:"#f5f3ff",padding:"6px 10px",borderRadius:8,marginBottom:10,fontFamily:F}}>
            All-cash buy -> rehab -> cash-out refi -> keep as rental
          </div>
          <InputField label="Cash Out Refi Amount" val={p.brrrCashOut||Math.round((p.homeValueMedian||0)*0.8)}
            set={v=>u("brrrCashOut",v)} pre="$" note="Pre-filled at 80% median" mobile={mobile} />
          <DataRow label="80% of Median (suggested)" value={$(Math.round((p.homeValueMedian||0)*0.8))} color={C.textMuted} />
          <DataRow label="Est. Mortgage /mo" value={$mo(m.brrrMtg)} />
          <DataRow label="BRRR Cash Flow /mo" value={$mo(m.brrrCF)} color={cfC(m.brrrCF)} />
          <DataRow label="Cash Recovered" value={$(m.brrrCashOut - m.cashOOP)} color={cfC(m.brrrCashOut - m.cashOOP)} />
        </SectionBlock>

        {/* Fix & Flip - collapsible */}
        <SectionBlock title="Fix & Flip" color={C.red} collapsible defaultOpen={false}>
          <div style={{fontSize:12,color:C.red,background:"#fef2f2",padding:"6px 10px",borderRadius:8,marginBottom:10,fontFamily:F}}>
            ARV pre-filled from Home Value High
          </div>
          <InputField label="Sale Price (ARV)" val={p.flipSalePrice||0} set={v=>u("flipSalePrice",v)} pre="$" mobile={mobile} />
          <InputField label="Agent Fee %" val={p.agentFeePct||6} set={v=>u("agentFeePct",v)} suf="%" mobile={mobile} />
          <DataRow label="Total Into Deal" value={$(m.cashOOP)} />
          <DataRow label="Agent Fee" value={$(m.agentFee)} />
          <DataRow label="Net Profit" value={$(m.flipProfit)} color={cfC(m.flipProfit)} />
          <DataRow label="ROI" value={pct(m.flipROI)} color={cfC(m.flipProfit)} />
        </SectionBlock>

        {/* Repair Estimator */}
        <SectionBlock title="🔨 Repair Estimator" color={C.textSub}>
          {p.sqft>0 && (
            <div style={{fontSize:12,color:C.textSub,background:C.bg,padding:"6px 10px",borderRadius:8,marginBottom:10,fontFamily:F}}>
              {(p.sqft).toLocaleString()} sqft x ${renoRates.light}/${renoRates.medium}/${renoRates.full} per sqft
            </div>
          )}
          <InputField label="Light Reno" val={p.repairLight||0} set={v=>u("repairLight",v)} pre="$" mobile={mobile} />
          <InputField label="Medium Reno" val={p.repairMedium||0} set={v=>u("repairMedium",v)} pre="$" mobile={mobile} />
          <InputField label="Full Reno" val={p.repairFull||0} set={v=>u("repairFull",v)} pre="$" mobile={mobile} />
        </SectionBlock>

        {/* Home Value */}
        <SectionBlock title="🏡 Home Value" color="#0891b2">
          <InputField label="Low" val={p.homeValueLow||0} set={v=>u("homeValueLow",v)} pre="$" mobile={mobile} />
          <InputField label="Median" val={p.homeValueMedian||0}
            set={v=>{ set({...p, homeValueMedian:v, brrrCashOut:Math.round(v*0.8)}); }} pre="$" mobile={mobile} />
          <InputField label="High (ARV)" val={p.homeValueHigh||0}
            set={v=>{ set({...p, homeValueHigh:v, flipSalePrice:v}); }} pre="$" mobile={mobile} />
          <DataRow label="Tax Value" value={$(p.taxValue)} />
          <DataRow label="BRRR 80% Median" value={$(Math.round((p.homeValueMedian||0)*0.8))} color={C.purple} />
        </SectionBlock>

        {/* Summary */}
        <SectionBlock title="Quick Summary" color={C.sidebar}>
          <DataRow label="Strategy" value={(p.chosenStrategy||"finance")==="cash"?"All Cash":"Financed"} />
          <DataRow label="Out of Pocket" value={$(m.chosenOOP)} />
          <DataRow label="Net Cash Flow /mo" value={$mo(m.chosenCF)} color={cfC(m.chosenCF)} />
          <DataRow label="Cash-on-Cash" value={pct(m.chosenCoC)} color={cfC(m.chosenCoC)} />
          <DataRow label="Cap Rate" value={pct(m.chosenCap)} />
          <DataRow label="Years to Payoff" value={m.payoff>0 ? m.payoff.toFixed(1)+" yrs" : "--"} />
          <DataRow label="Yearly Rent (gross)" value={$((p.rentAmount||0)*12)} />
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

  const totalCF    = properties.reduce((s,p) => s+calc(p).chosenCF, 0);
  const totalVal   = properties.reduce((s,p) => s+(p.purchasePrice||0), 0);
  const occupied   = properties.filter(p => p.occupied).length;
  const monthlyRent= properties.reduce((s,p) => s+(p.rentAmount||0), 0);
  const alerts     = properties.filter(p => {
    const d = dU(p.leaseEnd);
    return p.tenantStatus==="Late" || (d!=null && d<=60 && d>=0);
  });

  return (
    <div style={{padding:mobile?"16px 16px 100px":"28px 32px"}}>
      {/* Hero */}
      <div style={{background:"linear-gradient(135deg,"+C.sidebar+",#374151)", borderRadius:16,
        padding:mobile?"20px":"28px 32px", marginBottom:24, color:"white"}}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start"}}>
          <div>
            <div style={{fontSize:12, opacity:.65, fontFamily:F, fontWeight:600, letterSpacing:".06em",
              textTransform:"uppercase", marginBottom:6}}>Total Monthly Cash Flow</div>
            <div style={{fontSize:mobile?36:48, fontWeight:900, fontFamily:F, lineHeight:1,
              color:totalCF>=0?"white":"#fca5a5"}}>{$mo(totalCF)}</div>
            <div style={{fontSize:13, opacity:.65, fontFamily:F, marginTop:6}}>
              {properties.length} properties - ${(totalVal/1000).toFixed(0)}k portfolio
            </div>
          </div>
          <button onClick={onAdd} style={{background:"rgba(255,255,255,.15)",
            border:"1px solid rgba(255,255,255,.3)", borderRadius:10,
            padding:"10px 16px", color:"white", fontWeight:600, fontSize:14, fontFamily:F, cursor:"pointer"}}>
            + Add Property
          </button>
        </div>
        <div style={{display:"grid", gridTemplateColumns:"repeat("+(mobile?2:4)+",1fr)",
          gap:16, marginTop:20, paddingTop:18, borderTop:"1px solid rgba(255,255,255,.15)"}}>
          {[["Properties",properties.length],["Occupied",occupied+"/"+properties.length],
            ["Rent /mo",$(monthlyRent)],["Alerts",alerts.length]].map(([l,v]) => (
            <div key={l}>
              <div style={{fontSize:mobile?20:22, fontWeight:800, fontFamily:F}}>{v}</div>
              <div style={{fontSize:11, opacity:.65, fontFamily:F, marginTop:2}}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Alerts */}
      {alerts.map(p => {
        const isLate = p.tenantStatus==="Late";
        const days   = dU(p.leaseEnd);
        return (
          <div key={p.id} onClick={()=>onSelect(p.id)}
            style={{background:isLate?"#fee2e2":"#fff7ed",
              border:"1px solid "+(isLate?"#fca5a5":"#fed7aa"),
              borderRadius:12, padding:"12px 16px", marginBottom:10,
              display:"flex", gap:12, alignItems:"center", cursor:"pointer"}}>
            <span style={{fontSize:20}}>{isLate?"[!!]":"[!]"}</span>
            <div style={{flex:1}}>
              <div style={{fontWeight:700, color:isLate?C.red:"#ea580c", fontSize:14, fontFamily:F}}>
                {isLate ? "Late Rent" : "Lease Expiring in "+days+" days"}
              </div>
              <div style={{fontSize:13, color:C.text, fontFamily:F}}>{p.address} - {p.tenantName||"Tenant"}</div>
            </div>
            <span style={{color:C.textMuted, fontSize:18}}>></span>
          </div>
        );
      })}

      {alerts.length===0 && properties.length>0 && (
        <div style={{background:C.greenLight, border:"1px solid #6ee7b7",
          borderRadius:12, padding:"12px 16px", marginBottom:16,
          display:"flex", gap:10, alignItems:"center"}}>
          <span style={{fontSize:20}}>[OK]</span>
          <div style={{fontWeight:600, color:C.greenDark, fontSize:14, fontFamily:F}}>All clear -- no alerts right now</div>
        </div>
      )}

      {/* Map */}
      {properties.length > 0 && (
        <div style={{marginBottom:24}}>
          <div style={{fontSize:14, fontWeight:700, color:C.text, fontFamily:F, marginBottom:10}}>📍 Property Map</div>
          <div style={{height:mobile?260:360, borderRadius:14, overflow:"hidden", border:"1px solid "+C.border}}>
            {mapReady
              ? <MapView properties={properties} onSelect={onSelect} />
              : <div style={{height:"100%", background:C.bg, display:"flex", alignItems:"center",
                  justifyContent:"center", color:C.textMuted, fontFamily:F}}>Loading map...</div>}
          </div>
        </div>
      )}

      {/* Property grid */}
      <div style={{fontSize:14, fontWeight:700, color:C.text, fontFamily:F, marginBottom:14}}>
        Properties ({properties.length})
      </div>

      {properties.length === 0 ? (
        <Card style={{padding:48, textAlign:"center"}}>
          <div style={{fontSize:48, marginBottom:12}}>🏘</div>
          <div style={{fontSize:17, fontWeight:700, color:C.text, fontFamily:F}}>No properties yet</div>
          <div style={{fontSize:14, color:C.textSub, fontFamily:F, margin:"8px 0 20px"}}>
            Add your first property to get started
          </div>
          <button onClick={onAdd} style={btnStyle("primary","lg")}>+ Add First Property</button>
        </Card>
      ) : (
        <div style={{display:"grid", gridTemplateColumns:mobile?"1fr":"repeat(auto-fill,minmax(300px,1fr))", gap:14}}>
          {properties.map(p => {
            const m = calc(p), ob = obBadge(p), days = dU(p.leaseEnd), st = stStyle(p.tenantStatus);
            return (
              <Card key={p.id} onClick={()=>onSelect(p.id)} style={{cursor:"pointer"}}
                onMouseEnter={e=>e.currentTarget.style.boxShadow="0 4px 16px rgba(0,0,0,.1)"}
                onMouseLeave={e=>e.currentTarget.style.boxShadow="0 1px 4px rgba(0,0,0,.05)"}>
                {p.lat && p.lng ? (
                  <div style={{position:"relative", height:140, overflow:"hidden"}}>
                    <img src={svUrl(p.lat,p.lng,900,280)} alt="" style={{width:"100%", height:"100%", objectFit:"cover"}} />
                    <div style={{position:"absolute", inset:0, background:"linear-gradient(to bottom,transparent 40%,rgba(0,0,0,.65))"}} />
                    <div style={{position:"absolute", bottom:10, left:14}}>
                      <div style={{color:"white", fontWeight:700, fontSize:14, fontFamily:F}}>{p.address}</div>
                      <div style={{color:"rgba(255,255,255,.8)", fontSize:12, fontFamily:F}}>{p.city}, {p.state}</div>
                    </div>
                    <div style={{position:"absolute", top:10, right:10}}><Badge label={ob.label} bg={ob.bg} c={ob.c} /></div>
                  </div>
                ) : (
                  <div style={{padding:"14px 16px", borderBottom:"1px solid "+C.border,
                    display:"flex", justifyContent:"space-between"}}>
                    <div>
                      <div style={{fontWeight:700, fontSize:14, color:C.text, fontFamily:F}}>{p.address}</div>
                      <div style={{fontSize:12, color:C.textSub, fontFamily:F}}>{p.city}, {p.state}</div>
                    </div>
                    <Badge label={ob.label} bg={ob.bg} c={ob.c} />
                  </div>
                )}
                <div style={{padding:"12px 14px"}}>
                  <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:10}}>
                    {[["CF/mo",m.chosenCF,$mo(m.chosenCF)],["CoC",m.chosenCoC,pct(m.chosenCoC)],["Cap",m.chosenCap,pct(m.chosenCap)]].map(([l,v,sv]) => (
                      <div key={l} style={{textAlign:"center", background:C.bg, borderRadius:8, padding:"8px 6px"}}>
                        <div style={{fontSize:10, color:C.textMuted, fontFamily:F}}>{l}</div>
                        <div style={{fontSize:14, fontWeight:700,
                          color:["CF/mo","CoC"].includes(l)?cfC(v):C.text, fontFamily:F}}>{sv}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                    <Badge label={p.tenantStatus} bg={st.bg} c={st.c} />
                    <span style={{fontSize:12, color:C.textMuted, fontFamily:F}}>{p.beds}bd - {p.baths}ba</span>
                  </div>
                  {days!=null && days<=60 && days>=0 && (
                    <div style={{marginTop:8, background:"#fff7ed", borderRadius:8, padding:"5px 10px",
                      fontSize:12, color:"#ea580c", fontWeight:600, fontFamily:F}}>
                      Lease expires in {days} days
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
          <div onClick={onAdd}
            style={{border:"2px dashed "+C.border, borderRadius:12, padding:28,
              display:"flex", flexDirection:"column", alignItems:"center", cursor:"pointer",
              color:C.textMuted, gap:6, minHeight:140, justifyContent:"center", transition:"all .15s"}}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=C.green;e.currentTarget.style.color=C.green;e.currentTarget.style.background="#f0fdf4";}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.color=C.textMuted;e.currentTarget.style.background="transparent";}}>
            <div style={{fontSize:32}}>+</div>
            <div style={{fontSize:14, fontWeight:600, fontFamily:F}}>Add Property</div>
          </div>
        </div>
      )}
    </div>
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
    <div style={{padding:mobile?"16px 16px 100px":"28px 32px"}}>
      <PageHeader title="My Properties" subtitle={properties.length+" properties in your portfolio"}
        action={<button onClick={onAdd} style={btnStyle("primary","md")}>+ Add Property</button>} />

      <div style={{display:"grid", gridTemplateColumns:mobile?"1fr 1fr":"repeat(4,1fr)", gap:12, marginBottom:24}}>
        <StatCard label="Total" value={properties.length} icon="🏘" />
        <StatCard label="Occupied" value={properties.filter(p=>p.occupied).length+"/"+properties.length} color={C.green} icon="[OK]" />
        <StatCard label="Rent /mo" value={$(totalRent)} color={C.green} icon="💰" />
        <StatCard label="Net CF /mo" value={$mo(totalCF)} color={cfC(totalCF)} icon="📈" />
      </div>

      <div style={{display:"flex", gap:10, marginBottom:16, flexWrap:"wrap"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)}
          placeholder="Search by address or city..."
          style={{...iS(mobile), flex:1, minWidth:200}} />
        <div style={{display:"flex", gap:6, flexWrap:"wrap"}}>
          {[["all","All"],["occupied","Occupied"],["vacant","Vacant"],["late","Late"]].map(([id,label]) => (
            <button key={id} onClick={()=>setFilter(id)} style={btnStyle(filter===id?"primary":"secondary","sm")}>{label}</button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card style={{padding:48, textAlign:"center"}}>
          <div style={{fontSize:36, marginBottom:10}}>🔍</div>
          <div style={{fontSize:15, fontWeight:600, fontFamily:F, color:C.text}}>
            {search ? "No properties match your search" : "No properties yet"}
          </div>
          {!search && <button onClick={onAdd} style={{...btnStyle("primary","md"), marginTop:16}}>+ Add First Property</button>}
        </Card>
      ) : (
        <Card>
          {!mobile && (
            <div style={{display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr 1fr 1fr auto",
              gap:12, padding:"10px 16px", background:C.bg, borderBottom:"1px solid "+C.border,
              fontSize:11, fontWeight:700, color:C.textMuted, textTransform:"uppercase", letterSpacing:".05em", fontFamily:F}}>
              {["Property","Type","Tenant","Cash Flow","CoC","Status",""].map(h => <div key={h}>{h}</div>)}
            </div>
          )}
          {filtered.map((p,i) => {
            const m = calc(p), ob = obBadge(p), st = stStyle(p.tenantStatus);
            return (
              <div key={p.id} style={{borderBottom:i<filtered.length-1?"1px solid "+C.border:"none"}}>
                {mobile ? (
                  <div onClick={()=>onSelect(p.id)}
                    style={{padding:16, cursor:"pointer", display:"flex", gap:12, alignItems:"center"}}>
                    {p.lat && p.lng && (
                      <div style={{width:60, height:60, borderRadius:10, overflow:"hidden", flexShrink:0}}>
                        <img src={svUrl(p.lat,p.lng,120,120)} alt=""
                          style={{width:"100%", height:"100%", objectFit:"cover"}} />
                      </div>
                    )}
                    <div style={{flex:1, minWidth:0}}>
                      <div style={{fontWeight:700, fontSize:14, color:C.text, fontFamily:F,
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{p.address}</div>
                      <div style={{fontSize:12, color:C.textSub, fontFamily:F}}>{p.city}, {p.state}</div>
                      <div style={{display:"flex", gap:8, marginTop:6, alignItems:"center"}}>
                        <span style={{fontSize:14, fontWeight:700, color:cfC(m.chosenCF), fontFamily:F}}>{$mo(m.chosenCF)}</span>
                        <Badge label={p.tenantStatus} bg={st.bg} c={st.c} />
                      </div>
                    </div>
                    <span style={{color:C.textMuted, fontSize:18}}>></span>
                  </div>
                ) : (
                  <div style={{display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr 1fr 1fr auto",
                    gap:12, padding:"12px 16px", alignItems:"center", cursor:"pointer", transition:"background .1s"}}
                    onClick={()=>onSelect(p.id)}
                    onMouseEnter={e=>e.currentTarget.style.background=C.bg}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <div style={{display:"flex", gap:10, alignItems:"center"}}>
                      {p.lat && p.lng && (
                        <div style={{width:44, height:44, borderRadius:8, overflow:"hidden", flexShrink:0}}>
                          <img src={svUrl(p.lat,p.lng,88,88)} alt=""
                            style={{width:"100%", height:"100%", objectFit:"cover"}} />
                        </div>
                      )}
                      <div>
                        <div style={{fontWeight:600, fontSize:14, color:C.text, fontFamily:F}}>{p.address}</div>
                        <div style={{fontSize:12, color:C.textSub, fontFamily:F}}>{p.city}, {p.state} - {p.beds}bd {p.baths}ba</div>
                      </div>
                    </div>
                    <div style={{fontSize:13, color:C.textSub, fontFamily:F}}>{p.type}</div>
                    <div style={{fontSize:13, color:C.text, fontFamily:F,
                      overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{p.tenantName||"--"}</div>
                    <div style={{fontSize:14, fontWeight:700, color:cfC(m.chosenCF), fontFamily:F}}>{$mo(m.chosenCF)}</div>
                    <div style={{fontSize:13, fontWeight:600, color:cfC(m.chosenCoC), fontFamily:F}}>{pct(m.chosenCoC)}</div>
                    <Badge label={p.tenantStatus} bg={st.bg} c={st.c} />
                    <button onClick={e=>{e.stopPropagation();if(window.confirm("Delete?"))onDelete(p.id);}}
                      style={btnStyle("danger","sm")}>Del</button>
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
function PropertyDetail({prop, onBack, onChange, onDelete, llcs, renoRates, mobile}) {
  const [tab, setTab] = useState("overview");
  const m = calc(prop);
  const u = (f,v) => onChange({...prop, [f]:v});
  const tabs = [["overview","Overview"],["calculator","Calculator"],["tenant","Tenant"],["projects","Projects"],["notes","Notes"]];

  return (
    <div style={{paddingBottom:mobile?100:40}}>
      {/* Sticky header */}
      <div style={{background:"white", borderBottom:"1px solid "+C.border,
        padding:mobile?"12px 16px":"14px 28px",
        position:"sticky", top:mobile?0:56, zIndex:50}}>
        <div style={{display:"flex", alignItems:"center", gap:12, marginBottom:10}}>
          <button onClick={onBack}
            style={{background:C.bg, border:"1px solid "+C.border, borderRadius:8,
              width:34, height:34, fontSize:18, cursor:"pointer",
              display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0}}><</button>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontWeight:800, fontSize:mobile?15:17, color:C.text, fontFamily:F,
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{prop.address}</div>
            <div style={{fontSize:12, color:C.textSub, fontFamily:F}}>{prop.city}, {prop.state} - {prop.llc}</div>
          </div>
          <div style={{display:"flex", gap:8}}>
            <a href={"https://www.zillow.com/homes/"+encodeURIComponent(prop.address+" "+prop.city)+"_rb/"}
              target="_blank" rel="noreferrer"
              style={{...btnStyle("blue","sm"), textDecoration:"none"}}>Zillow</a>
            <button onClick={()=>{ if(window.confirm("Delete this property?")) onDelete(prop.id); }}
              style={btnStyle("danger","sm")}>Delete</button>
          </div>
        </div>
        <div style={{display:"flex", overflowX:"auto", WebkitOverflowScrolling:"touch", scrollbarWidth:"none"}}>
          {tabs.map(([id,label]) => (
            <button key={id} onClick={()=>setTab(id)}
              style={{padding:"8px 14px", border:"none", background:"none", cursor:"pointer",
                fontSize:13, fontWeight:tab===id?700:400,
                color:tab===id?C.green:C.textMuted,
                borderBottom:tab===id?"2px solid "+C.green:"2px solid transparent",
                fontFamily:F, whiteSpace:"nowrap", flexShrink:0}}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{padding:mobile?"16px":"24px 28px"}}>
        {/* KPI strip */}
        <div style={{display:"grid", gridTemplateColumns:mobile?"1fr 1fr":"repeat(4,1fr)", gap:12, marginBottom:20}}>
          {[
            ["CF/mo ("+(prop.chosenStrategy==="cash"?"Cash":"Fin.")+")", $mo(m.chosenCF), cfC(m.chosenCF)],
            ["Cash-on-Cash", pct(m.chosenCoC), cfC(m.chosenCoC)],
            ["Cap Rate", pct(m.chosenCap), C.text],
            ["Out of Pocket", $(m.chosenOOP), C.text],
          ].map(([l,v,c]) => (
            <Card key={l} style={{padding:"14px 16px"}}>
              <div style={{fontSize:11, color:C.textMuted, fontWeight:600, textTransform:"uppercase", letterSpacing:".05em", fontFamily:F}}>{l}</div>
              <div style={{fontSize:20, fontWeight:800, color:c, fontFamily:F, marginTop:4}}>{v}</div>
            </Card>
          ))}
        </div>

        {tab==="overview" && (
          <div>
            <StreetViewImg lat={prop.lat} lng={prop.lng} address={prop.address} height={200} />
            <Card style={{padding:16, marginBottom:14}}>
              <div style={{fontSize:13, fontWeight:700, color:C.text, fontFamily:F, marginBottom:12}}>Property Details</div>
              <div style={{display:"grid", gridTemplateColumns:mobile?"1fr 1fr":"repeat(4,1fr)", gap:12}}>
                {[["Type",prop.type],["Beds/Baths",prop.beds+"bd "+prop.baths+"ba"],
                  ["Sq Ft",(prop.sqft||0).toLocaleString()],["Built",prop.yearBuilt||"--"],
                  ["Tax Value",$(prop.taxValue)],["Lockbox",prop.lockboxCode||"--"],
                  ["Parcel ID",prop.parcelId||"--"],["LLC",prop.llc]].map(([l,v]) => (
                  <div key={l}>
                    <div style={{fontSize:11, color:C.textMuted, fontFamily:F}}>{l}</div>
                    <div style={{fontSize:14, fontWeight:600, color:C.text, fontFamily:F, marginTop:2}}>{v}</div>
                  </div>
                ))}
              </div>
            </Card>
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14}}>
              <a href={"https://maps.google.com/?q="+encodeURIComponent(prop.address+" "+prop.city)}
                target="_blank" rel="noreferrer"
                style={{...btnStyle("secondary","md"), textDecoration:"none"}}>📍 Google Maps</a>
              <a href={"https://www.zillow.com/homes/"+encodeURIComponent(prop.address+" "+prop.city)+"_rb/"}
                target="_blank" rel="noreferrer"
                style={{...btnStyle("blue","md"), textDecoration:"none"}}>🏠 Zillow</a>
            </div>
          </div>
        )}
        {tab==="calculator" && <Calculator p={prop} set={onChange} renoRates={renoRates} mobile={mobile} />}
        {tab==="tenant"     && <TenantSection p={prop} set={onChange} mobile={mobile} />}
        {tab==="projects"   && <ProjectsSection p={prop} set={onChange} mobile={mobile} />}
        {tab==="notes"      && (
          <SectionBlock title="Notes & Details" color={C.greenMid}>
            <textarea value={prop.notes||""} onChange={e=>u("notes",e.target.value)}
              placeholder="Lockbox codes, quit claim, lead safe, legal notes..."
              style={{...iS(mobile), minHeight:200, resize:"vertical"}} />
          </SectionBlock>
        )}
      </div>
    </div>
  );
}

// -- Tenant Section ------------------------------------------------------------
function TenantSection({p, set, mobile}) {
  const u = (f,v) => set({...p,[f]:v}), days = dU(p.leaseEnd), st = stStyle(p.tenantStatus);
  return (
    <div>
      {p.tenantPhone && (
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14}}>
          <a href={"tel:"+p.tenantPhone} style={{...btnStyle("primary","md"), textDecoration:"none"}}>📞 Call</a>
          <a href={"sms:"+p.tenantPhone} style={{...btnStyle("secondary","md"), textDecoration:"none"}}>💬 Text</a>
        </div>
      )}
      {days!==null && days<=60 && days>=0 && (
        <div style={{background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:10, padding:"10px 14px", marginBottom:14,
          fontSize:13, color:"#ea580c", fontWeight:600, fontFamily:F}}>
          Lease expiring in {days} days -- follow up about renewal
        </div>
      )}
      {days!==null && days<0 && (
        <div style={{background:"#fee2e2", border:"1px solid #fca5a5", borderRadius:10, padding:"10px 14px", marginBottom:14,
          fontSize:13, color:C.red, fontWeight:700, fontFamily:F}}>
          [!!] Lease EXPIRED {Math.abs(days)} days ago
        </div>
      )}
      <SectionBlock title="👤 Tenant Information" color="#0891b2">
        <div style={{display:"grid", gridTemplateColumns:mobile?"1fr":"1fr 1fr", gap:12}}>
          <InputField label="Tenant Name" val={p.tenantName||""} set={v=>u("tenantName",v)} type="text" mobile={mobile} />
          <InputField label="Phone" val={p.tenantPhone||""} set={v=>u("tenantPhone",v)} type="text" mobile={mobile} />
          <InputField label="Email" val={p.tenantEmail||""} set={v=>u("tenantEmail",v)} type="text" mobile={mobile} />
          <InputField label="Security Deposit $" val={p.rentDeposit||0} set={v=>u("rentDeposit",v)} pre="$" mobile={mobile} />
          <div>
            <label style={{fontSize:13,color:C.textSub,fontWeight:500,display:"block",marginBottom:5,fontFamily:F}}>Lease Start</label>
            <input type="date" value={p.leaseStart||""} onChange={e=>u("leaseStart",e.target.value)} style={iS(mobile)} />
          </div>
          <div>
            <label style={{fontSize:13,color:C.textSub,fontWeight:500,display:"block",marginBottom:5,fontFamily:F}}>Lease End</label>
            <input type="date" value={p.leaseEnd||""} onChange={e=>u("leaseEnd",e.target.value)} style={iS(mobile)} />
          </div>
          <div>
            <label style={{fontSize:13,color:C.textSub,fontWeight:500,display:"block",marginBottom:5,fontFamily:F}}>Payment Status</label>
            <select value={p.tenantStatus} onChange={e=>u("tenantStatus",e.target.value)} style={iS(mobile)}>
              {["Current","Late","Partial","Vacant"].map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label style={{fontSize:13,color:C.textSub,fontWeight:500,display:"block",marginBottom:5,fontFamily:F}}>Occupancy</label>
            <select value={p.occupied?"Occupied":"Vacant"} onChange={e=>u("occupied",e.target.value==="Occupied")} style={iS(mobile)}>
              <option>Occupied</option><option>Vacant</option>
            </select>
          </div>
        </div>
      </SectionBlock>
    </div>
  );
}

// -- Projects Section ----------------------------------------------------------
function ProjectsSection({p, set, mobile}) {
  const [exp,setExp] = useState(null);
  const [nP,setNP]   = useState({name:"",budget:0,contractor:"",status:"In Progress"});
  const [lg,setLg]   = useState({});
  const stC = s => s==="Complete"?C.green:s==="In Progress"?C.blue:C.textMuted;
  const add = () => {
    if(!nP.name) return;
    set({...p, projects:[...(p.projects||[]),{id:"pr"+Date.now(),...nP,spent:0,isCapEx:!p.occupied,log:[]}]});
    setNP({name:"",budget:0,contractor:"",status:"In Progress"});
  };
  const addLog = pid => {
    if(!lg[pid]) return;
    set({...p, projects:(p.projects||[]).map(pr=>pr.id===pid?{...pr,log:[...(pr.log||[]),{date:new Date().toISOString().split("T")[0],note:lg[pid]}]}:pr)});
    setLg(x=>({...x,[pid]:""}));
  };
  return (
    <div>
      <div style={{background:"#f5f3ff",borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:13,color:C.purple,fontFamily:F}}>
        💡 <b>Vacant</b> = CapEx (pre-tenant) - <b>Occupied</b> = Operating Expense
      </div>
      {(p.projects||[]).map(pr => (
        <Card key={pr.id} style={{marginBottom:12, overflow:"hidden"}}>
          <div style={{padding:"14px 16px", display:"flex", justifyContent:"space-between", cursor:"pointer"}}
            onClick={()=>setExp(exp===pr.id?null:pr.id)}>
            <div>
              <div style={{fontWeight:700, fontSize:14, fontFamily:F}}>{pr.name}</div>
              <div style={{display:"flex", gap:6, marginTop:5}}>
                <span style={{background:stC(pr.status)+"20",color:stC(pr.status),padding:"2px 8px",borderRadius:20,fontSize:11,fontWeight:600,fontFamily:F}}>{pr.status}</span>
                <span style={{background:pr.isCapEx?"#fef3c7":"#dbeafe",color:pr.isCapEx?"#b45309":C.blue,padding:"2px 8px",borderRadius:20,fontSize:11,fontWeight:600,fontFamily:F}}>{pr.isCapEx?"CapEx":"Expense"}</span>
              </div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:13,color:C.textSub,fontFamily:F}}>{$(pr.budget)}</div>
              <div style={{fontSize:13,fontWeight:700,color:pr.spent>pr.budget?C.red:C.green,fontFamily:F}}>{$(pr.spent)} spent</div>
            </div>
          </div>
          {exp===pr.id && (
            <div style={{borderTop:"1px solid "+C.border, padding:16}}>
              {(pr.log||[]).map((l,i) => (
                <div key={i} style={{borderLeft:"3px solid "+C.purple, paddingLeft:10, marginBottom:10}}>
                  <div style={{fontSize:11,color:C.textMuted,fontFamily:F}}>{l.date}</div>
                  <div style={{fontSize:13,fontFamily:F,color:C.text}}>{l.note}</div>
                </div>
              ))}
              <div style={{display:"flex",gap:8,marginTop:8}}>
                <input placeholder="Add update..." value={lg[pr.id]||""}
                  onChange={e=>setLg(x=>({...x,[pr.id]:e.target.value}))}
                  onKeyDown={e=>e.key==="Enter"&&addLog(pr.id)}
                  style={{...iS(mobile),flex:1}} />
                <button onClick={()=>addLog(pr.id)} style={btnStyle("primary","sm")}>Log</button>
              </div>
              <button onClick={()=>set({...p,projects:(p.projects||[]).filter(x=>x.id!==pr.id)})}
                style={{...btnStyle("danger","sm"), marginTop:10, width:"100%"}}>Delete Project</button>
            </div>
          )}
        </Card>
      ))}
      <Card style={{padding:16}}>
        <div style={{fontSize:14,fontWeight:700,color:C.purple,marginBottom:12,fontFamily:F}}>+ New Project</div>
        <InputField label="Project Name" val={nP.name} set={v=>setNP(x=>({...x,name:v}))} type="text" mobile={mobile} />
        <InputField label="Contractor" val={nP.contractor} set={v=>setNP(x=>({...x,contractor:v}))} type="text" mobile={mobile} />
        <InputField label="Budget $" val={nP.budget||0} set={v=>setNP(x=>({...x,budget:v}))} mobile={mobile} />
        <div style={{marginBottom:12}}>
          <label style={{fontSize:13,color:C.textSub,fontWeight:500,display:"block",marginBottom:5,fontFamily:F}}>Status</label>
          <select value={nP.status} onChange={e=>setNP(x=>({...x,status:e.target.value}))} style={iS(mobile)}>
            <option>In Progress</option><option>Complete</option><option>Planned</option>
          </select>
        </div>
        <button onClick={add} style={{...btnStyle("primary","md"),width:"100%"}}>Add Project</button>
      </Card>
    </div>
  );
}

// -- Deal Analyzer -------------------------------------------------------------
function DealAnalyzer({deals=[], onSave, renoRates={light:7,medium:13,full:45}, onMoveToPortfolio, mobile}) {
  const [d, setD]       = useState(() => newDeal());
  const [loading, setL] = useState(false);
  const [err, setErr]   = useState("");
  const u = (f,v) => setD(prev => ({...prev, [f]:v}));

  const runSearch = async () => {
    if (!d.address) { setErr("Enter an address first."); return; }
    setL(true); setErr("");
    try {
      const data = await attomFetch(d.address, d.city, d.state, d.zip);
      setD(prev => applyAttom(prev, data, renoRates));
    } catch {
      setErr("Search failed. Check the address and try again.");
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
    <div style={{padding:mobile?"16px 16px 100px":"28px 32px"}}>
      <PageHeader title="Deal Analyzer" subtitle="Analyze any deal before making an offer"
        action={<button onClick={()=>{setD(newDeal());setErr("");}} style={btnStyle("secondary","md")}>🗑 Clear</button>} />

      {/* Address */}
      <SectionBlock title="Property Address" color={C.green}>
        <div style={{marginBottom:12}}>
          <label style={{fontSize:13,color:C.textSub,fontWeight:500,display:"block",marginBottom:5,fontFamily:F}}>
            Start typing to search
          </label>
          <AddressInput value={d.address} onChange={v=>u("address",v)}
            onSelect={loc=>setD(prev=>({...prev,...loc,fullAddress:loc.fullAddress}))}
            placeholder="e.g. 9923 Bessemer Ave, Cleveland, OH..."
            mobile={mobile} />
        </div>
        <StreetViewImg lat={d.lat} lng={d.lng} address={d.fullAddress||d.address} height={180} />
        {d.city && (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginTop:12}}>
            {[["City","city"],["State","state"],["ZIP","zip"]].map(([l,f]) => (
              <div key={f}>
                <label style={{fontSize:12,color:C.textMuted,fontFamily:F,display:"block",marginBottom:4}}>{l}</label>
                <input value={d[f]||""} onChange={e=>u(f,e.target.value)} style={iS(mobile)} />
              </div>
            ))}
          </div>
        )}
        <button onClick={runSearch} disabled={loading}
          style={{...btnStyle("primary","md"), width:"100%", marginTop:14}}>
          {loading ? "Searching..." : "🔍 Run Search"}
        </button>
        {err && <div style={{color:C.red,fontSize:13,marginTop:8,fontFamily:F}}>{err}</div>}
        {d.taxValue > 0 && (
          <div style={{marginTop:12,background:C.greenLight,border:"1px solid #6ee7b7",borderRadius:10,padding:"10px 14px",fontSize:13,fontFamily:F}}>
            Tax /mo: <b style={{color:C.green}}>{$(d.expPropTax)} OK</b>
            {d.homeValueMedian>0 && <> - Market: <b style={{color:"#0891b2"}}>{$(d.homeValueMedian)}</b></>}
            {d.rentEstimate>0 && <> - Rent est: <b style={{color:C.green}}>{$(d.rentEstimate)}/mo OK</b></>}
          </div>
        )}
      </SectionBlock>

      {/* Property snapshot */}
      {d.beds > 0 && (
        <div style={{display:"grid",gridTemplateColumns:"repeat("+(mobile?2:4)+",1fr)",gap:10,marginBottom:16}}>
          {[["Beds",d.beds],["Baths",d.baths],["Sqft",(d.sqft||0).toLocaleString()],["Built",d.yearBuilt]].map(([l,v]) => (
            <Card key={l} style={{padding:"12px 10px",textAlign:"center"}}>
              <div style={{fontSize:11,color:C.textMuted,fontFamily:F}}>{l}</div>
              <div style={{fontSize:15,fontWeight:700,fontFamily:F}}>{v||"--"}</div>
            </Card>
          ))}
        </div>
      )}

      {/* Calculator */}
      <Calculator p={d} set={setD} renoRates={renoRates} mobile={mobile} />

      {/* Recommendation */}
      {d.purchasePrice > 0 && (
        <Card style={{padding:20,marginBottom:16,border:"2px solid "+(winner==="finance"?C.green:"#b45309")}}>
          <div style={{fontWeight:800,color:winner==="finance"?C.green:"#b45309",fontSize:17,fontFamily:F,marginBottom:14}}>
            💡 Recommendation: {winner==="finance"?"Financed":"All Cash"}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
            {[{id:"cash",label:"All Cash",color:"#b45309",cf:m.cashCF,coc:m.cashCoC,oop:m.cashOOP},
              {id:"finance",label:"Financed",color:C.green,cf:m.finCF,coc:m.finCoC,oop:m.finOOP}].map(sv => (
              <div key={sv.id} style={{background:winner===sv.id?(sv.color+"10"):C.bg,
                borderRadius:10,padding:14,border:"2px solid "+(winner===sv.id?sv.color:"transparent")}}>
                <div style={{fontWeight:700,color:sv.color,fontFamily:F,marginBottom:6}}>{winner===sv.id?"* ":""}{sv.label}</div>
                <div style={{fontSize:20,fontWeight:900,color:cfC(sv.cf),fontFamily:F}}>{$mo(sv.cf)}</div>
                <div style={{fontSize:12,color:C.textSub,fontFamily:F}}>CoC: {pct(sv.coc)}</div>
                <div style={{fontSize:12,color:C.textSub,fontFamily:F}}>OOP: {$(sv.oop)}</div>
              </div>
            ))}
          </div>
          <div style={{fontSize:13,color:C.text,lineHeight:1.7,fontFamily:F}}>
            {winner==="finance"
              ? "Financing makes more sense -- CoC of "+pct(m.finCoC)+" is strong. You keep $"+Math.round(m.cashOOP-m.finOOP).toLocaleString()+" in your pocket. After-mortgage cash flow: "+$mo(m.finCF)+"."
              : "All cash is better here -- financed cash flow of "+$mo(m.finCF)+" is too thin after the mortgage. All-cash gives you "+$mo(m.cashCF)+"/mo."}
          </div>
        </Card>
      )}

      {/* Deal Notes */}
      <SectionBlock title="Deal Notes" color={C.textSub}>
        <textarea value={d.notes||""} onChange={e=>u("notes",e.target.value)}
          placeholder="Notes on this deal -- seller motivation, condition, neighborhood, rehab scope..."
          style={{...iS(mobile), minHeight:100, resize:"vertical"}} />
      </SectionBlock>

      {/* Save */}
      <button onClick={saveDeal}
        style={{...btnStyle("primary","xl"), width:"100%", marginBottom:24}}>
        💾 Save as {(d.chosenStrategy||"finance")==="cash"?"All Cash":"Financed"} Deal
      </button>

      {/* Saved Deals */}
      {deals.length > 0 && (
        <div>
          <div style={{fontSize:17,fontWeight:800,color:C.text,fontFamily:F,marginBottom:14}}>
            Saved Deals ({deals.length})
          </div>
          <div style={{display:"grid",gridTemplateColumns:mobile?"1fr":"1fr 1fr",gap:14}}>
            {[...deals].sort((a,b)=>new Date(b.savedAt)-new Date(a.savedAt)).map(deal => {
              const dm = calc(deal);
              return (
                <Card key={deal.id} style={{padding:16}}>
                  {deal.lat && deal.lng && (
                    <div style={{margin:"-16px -16px 12px",height:100,overflow:"hidden",position:"relative"}}>
                      <img src={svUrl(deal.lat,deal.lng,900,200)} alt=""
                        style={{width:"100%",height:"100%",objectFit:"cover"}} />
                      <div style={{position:"absolute",inset:0,background:"linear-gradient(to bottom,transparent 30%,rgba(0,0,0,.6))"}} />
                      <div style={{position:"absolute",bottom:8,left:14,color:"white",fontWeight:700,fontSize:13,fontFamily:F}}>{deal.address}</div>
                    </div>
                  )}
                  {!deal.lat && (
                    <div style={{fontWeight:700,fontSize:14,fontFamily:F,marginBottom:6,
                      overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{deal.address}</div>
                  )}
                  <div style={{fontSize:12,color:C.textMuted,fontFamily:F,marginBottom:8}}>
                    {deal.city}, {deal.state} - {new Date(deal.savedAt).toLocaleDateString()}
                  </div>
                  {deal.notes && (
                    <div style={{fontSize:12,color:C.textSub,fontFamily:F,marginBottom:8,fontStyle:"italic",
                      overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>"{deal.notes}"</div>
                  )}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                    {[["CF/mo",$mo(dm.chosenCF),cfC(dm.chosenCF)],["CoC",pct(dm.chosenCoC),cfC(dm.chosenCoC)],
                      ["Cap Rate",pct(dm.chosenCap)],["Out of Pocket",$(dm.chosenOOP)]].map(([l,v,c]) => (
                      <div key={l} style={{background:C.bg,borderRadius:8,padding:"8px 10px"}}>
                        <div style={{fontSize:11,color:C.textMuted,fontFamily:F}}>{l}</div>
                        <div style={{fontSize:13,fontWeight:700,color:c||C.text,fontFamily:F}}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{display:"flex",gap:6}}>
                    <button onClick={()=>setD(deal)} style={btnStyle("secondary","sm")}>Load</button>
                    <button onClick={()=>onMoveToPortfolio(deal)}
                      style={{...btnStyle("primary","sm"),flex:1}}>-> Add to My Properties</button>
                    <button onClick={()=>onSave(deals.filter(x=>x.id!==deal.id))}
                      style={btnStyle("danger","sm")}>x</button>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  </div>
  );
}

// -- Lease Comps ---------------------------------------------------------------
function LeaseComps({rentcastKey, onSaveKey, mobile}) {
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
      const q = encodeURIComponent(loc.fullAddress||loc.address);
      const r = await fetch("https://api.rentcast.io/v1/properties?address="+q, {headers:{"X-Api-Key":rentcastKey}});
      const d = await r.json();
      if (d?.[0]?.bedrooms) { setBeds(d[0].bedrooms); setAuto(true); }
    } catch {}
  };

  const search = async () => {
    if (!rentcastKey) { setErr("Add your free Rentcast API key first."); return; }
    if (!address)     { setErr("Enter an address first."); return; }
    setL(true); setErr(""); setComps(null);
    try {
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
      setComps({estimate:d, listings});
    } catch { setErr("Search failed. Check your API key and address."); }
    setL(false);
  };

  const avg = comps?.listings?.length
    ? Math.round(comps.listings.reduce((s,l)=>s+(l.price||l.rent||0),0)/comps.listings.length)
    : 0;

  return (
    <div style={{padding:mobile?"16px 16px 100px":"28px 32px"}}>
      <PageHeader title="Lease Comps" subtitle="Search real rental comps near any address" />

      {(!rentcastKey || showKeyInput) && (
        <Card style={{padding:20, marginBottom:20, border:"2px solid "+C.amber}}>
          <div style={{fontSize:15,fontWeight:700,color:C.text,fontFamily:F,marginBottom:6}}>🔑 Rentcast API Key Required</div>
          <p style={{fontSize:13,color:C.textSub,fontFamily:F,margin:"0 0 12px",lineHeight:1.6}}>
            Sign up at <a href="https://rentcast.io" target="_blank" rel="noreferrer" style={{color:C.green,fontWeight:600}}>rentcast.io</a> -- free tier includes 50 searches/month, no credit card needed.
          </p>
          <div style={{display:"flex",gap:8}}>
            <input value={keyInput} onChange={e=>setKeyInput(e.target.value)}
              placeholder="Paste your free Rentcast API key..."
              style={{...iS(mobile),flex:1,fontFamily:"monospace",fontSize:13}} />
            <button onClick={()=>{if(keyInput){onSaveKey(keyInput);setShowKey(false);}}}
              style={btnStyle("primary","md")}>Save</button>
          </div>
        </Card>
      )}

      <SectionBlock title="Search Comps" color="#0891b2">
        <div style={{marginBottom:12}}>
          <label style={{fontSize:13,color:C.textSub,fontWeight:500,display:"block",marginBottom:5,fontFamily:F}}>Address</label>
          <AddressInput value={address} onChange={setAddress} onSelect={handleSelect}
            placeholder="Enter address to search nearby rentals..." mobile={mobile} />
        </div>
        <div style={{marginBottom:12}}>
          <label style={{fontSize:13,color:C.textSub,fontWeight:500,display:"block",marginBottom:5,fontFamily:F}}>
            Bedrooms {autoDetected && <span style={{color:C.green,fontSize:11,fontWeight:700}}>auto-detected</span>}
          </label>
          <select value={beds} onChange={e=>{setBeds(parseInt(e.target.value));setAuto(false);}} style={iS(mobile)}>
            {[1,2,3,4,5,6].map(n => <option key={n} value={n}>{n} bedroom{n>1?"s":""}</option>)}
          </select>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <button onClick={search} disabled={loading}
            style={{...btnStyle("primary","md"),flex:1}}>
            {loading ? "Searching..." : "🔍 Run Search"}
          </button>
          {rentcastKey && (
            <button onClick={()=>setShowKey(!showKeyInput)} style={btnStyle("secondary","sm")}>[gear] Key</button>
          )}
        </div>
        {err && <div style={{color:C.red,fontSize:13,marginTop:8,fontFamily:F}}>{err}</div>}
      </SectionBlock>

      {location && <StreetViewImg lat={location.lat} lng={location.lng} address={address} height={180} />}

      {comps && (
        <div>
          {comps.estimate?.rent && (
            <div style={{background:"linear-gradient(135deg,#0891b2,#0369a1)",borderRadius:16,padding:22,marginBottom:20,marginTop:14,color:"white"}}>
              <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",opacity:.8,fontFamily:F,letterSpacing:".06em"}}>
                Rentcast Market Rent Estimate - {beds} Bed
              </div>
              <div style={{fontSize:38,fontWeight:900,fontFamily:F,marginTop:6}}>{$(comps.estimate.rent)}/mo</div>
              <div style={{fontSize:14,opacity:.8,fontFamily:F}}>
                {$(comps.estimate.rentRangeLow)} - {$(comps.estimate.rentRangeHigh)}/mo range
              </div>
              {avg > 0 && (
                <div style={{fontSize:14,opacity:.8,fontFamily:F,marginTop:2}}>
                  Avg of {comps.listings.length} active listings: {$(avg)}/mo
                </div>
              )}
            </div>
          )}
          {comps.listings?.length > 0 ? (
            <div>
              <div style={{fontSize:16,fontWeight:700,fontFamily:F,marginBottom:14}}>
                🏠 Active Listings ({comps.listings.length})
              </div>
              <div style={{display:"grid",gridTemplateColumns:mobile?"1fr":"repeat(auto-fill,minmax(280px,1fr))",gap:16}}>
                {comps.listings.map((l,i) => {
                  const rent = l.price||l.rent||0;
                  const img  = l.photoUrl||(l.photos?.[0]?.url)||null;
                  return (
                    <Card key={l.id||i} style={{overflow:"hidden"}}>
                      <div style={{height:170,background:C.bg,position:"relative"}}>
                        {img
                          ? <img src={img} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} onError={e=>{e.target.style.display="none";}} />
                          : (l.latitude&&l.longitude)
                            ? <img src={svUrl(l.latitude,l.longitude,800,340)} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} />
                            : <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:40}}>🏠</div>
                        }
                        <div style={{position:"absolute",top:10,right:10}}>
                          <Badge label="Active" bg={C.greenLight} c={C.greenDark} />
                        </div>
                        {l.distance && (
                          <div style={{position:"absolute",bottom:10,left:10,background:"rgba(0,0,0,.6)",color:"white",padding:"2px 8px",borderRadius:8,fontSize:12,fontFamily:F}}>
                            {l.distance.toFixed(1)} mi
                          </div>
                        )}
                      </div>
                      <div style={{padding:14}}>
                        <div style={{fontWeight:900,fontSize:22,color:C.green,fontFamily:F}}>{$(rent)}/mo</div>
                        <div style={{fontSize:13,color:C.text,fontWeight:600,marginTop:4,fontFamily:F}}>{l.formattedAddress||l.address}</div>
                        <div style={{display:"flex",gap:12,marginTop:8,flexWrap:"wrap"}}>
                          {l.bedrooms   && <span style={{fontSize:12,color:C.textSub,fontFamily:F}}>🛏 {l.bedrooms}bd</span>}
                          {l.bathrooms  && <span style={{fontSize:12,color:C.textSub,fontFamily:F}}>🚿 {l.bathrooms}ba</span>}
                          {l.squareFootage && <span style={{fontSize:12,color:C.textSub,fontFamily:F}}>📐 {l.squareFootage.toLocaleString()} sqft</span>}
                        </div>
                        {l.listedDate && (
                          <div style={{fontSize:11,color:C.textMuted,marginTop:8,fontFamily:F}}>
                            Listed {new Date(l.listedDate).toLocaleDateString()}
                          </div>
                        )}
                        {l.latitude && l.longitude && (
                          <a href={"https://www.google.com/maps?q="+l.latitude+","+l.longitude}
                            target="_blank" rel="noreferrer"
                            style={{...btnStyle("secondary","sm"),marginTop:10,width:"100%",textDecoration:"none"}}>
                            View on Maps ->
                          </a>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          ) : (
            <Card style={{padding:36,textAlign:"center"}}>
              <div style={{fontSize:36,marginBottom:10}}>🔍</div>
              <div style={{fontSize:15,fontWeight:600,fontFamily:F,color:C.text}}>No active listings found nearby</div>
              <div style={{fontSize:13,color:C.textSub,fontFamily:F,marginTop:4}}>Market estimate above is still valid</div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// -- Settings ------------------------------------------------------------------
function SettingsPage({llcs, renoRates, onSave, onSignOut, mobile, userEmail}) {
  const [llcTxt,setLlcTxt] = useState(llcs.join("\n"));
  const [rates,setRates]   = useState({...renoRates});
  const [saved,setSaved]   = useState(false);
  const save = () => {
    onSave(llcTxt.split("\n").map(s=>s.trim()).filter(Boolean), rates);
    setSaved(true); setTimeout(()=>setSaved(false), 2000);
  };
  return (
    <div style={{padding:mobile?"16px 16px 100px":"28px 32px",maxWidth:640}}>
      <PageHeader title="Settings" />
      <SectionBlock title="Account" color={C.green}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontSize:14,fontWeight:600,color:C.text,fontFamily:F}}>{userEmail}</div>
            <div style={{fontSize:12,color:C.textSub,fontFamily:F,marginTop:2}}>DealHive account</div>
          </div>
          <button onClick={onSignOut} style={btnStyle("danger","md")}>Sign Out</button>
        </div>
      </SectionBlock>
      <SectionBlock title="Data Provider" color={C.textSub}>
        <div style={{background:C.greenLight,border:"1px solid #6ee7b7",borderRadius:10,padding:"12px 14px",marginBottom:10}}>
          <div style={{fontWeight:700,color:C.greenDark,fontSize:14,fontFamily:F,marginBottom:4}}>ATTOM Data API Connected</div>
          <div style={{fontSize:13,color:C.textSub,fontFamily:F}}>Property data, tax records, home values and rental estimates powered by ATTOM -- 158M+ U.S. properties.</div>
        </div>
        <div style={{background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:10,padding:"10px 14px"}}>
          <div style={{fontWeight:600,color:C.blue,fontSize:14,fontFamily:F,marginBottom:2}}>📊 Lease Comps -- Rentcast (free)</div>
          <div style={{fontSize:13,color:C.textSub,fontFamily:F}}>Add your free Rentcast key on the Lease Comps page. Free tier: 50 searches/month.</div>
        </div>
      </SectionBlock>
      <SectionBlock title="Repair Cost Rates ($/sqft)" color={C.textSub}>
        <InputField label="Light Reno ($/sqft)" val={rates.light} set={v=>setRates(x=>({...x,light:v}))} mobile={mobile} />
        <InputField label="Medium Reno ($/sqft)" val={rates.medium} set={v=>setRates(x=>({...x,medium:v}))} mobile={mobile} />
        <InputField label="Full Reno ($/sqft)" val={rates.full} set={v=>setRates(x=>({...x,full:v}))} mobile={mobile} />
      </SectionBlock>
      <SectionBlock title="Your LLCs" color={C.purple}>
        <p style={{fontSize:13,color:C.textSub,margin:"0 0 10px",fontFamily:F}}>One LLC per line</p>
        <textarea value={llcTxt} onChange={e=>setLlcTxt(e.target.value)}
          style={{...iS(mobile), minHeight:120, resize:"vertical"}} />
      </SectionBlock>
      <SectionBlock title="About" color={C.sidebar}>
        {[["Product","DealHive"],["Version",VERSION],["Website","dealhive.io"],
          ["Default Closing Costs","$"+DEFAULT_CLOSING.toLocaleString()],
          ["Default Vacancy Rate","5%"]].map(([l,v]) => (
          <DataRow key={l} label={l} value={v} />
        ))}
      </SectionBlock>
      <button onClick={save} style={{...btnStyle(saved?"primary":"primary","xl"),width:"100%"}}>
        {saved ? "Saved!" : "Save Settings"}
      </button>
    </div>
  );
}

// -- Add Property Modal --------------------------------------------------------
function AddPropertyModal({llcs, onAdd, onClose, renoRates, mobile}) {
  const [p,setP]       = useState(() => newProp());
  const [loading,setL] = useState(false);
  const [err,setErr]   = useState("");
  const u = (f,v) => setP(prev => ({...prev,[f]:v}));

  const runSearch = async () => {
    if (!p.address) { setErr("Enter an address first."); return; }
    setL(true); setErr("");
    try {
      const data = await attomFetch(p.address, p.city, p.state, p.zip);
      setP(prev => applyAttom(prev, data, renoRates));
    } catch { setErr("Search failed."); }
    setL(false);
  };

  const outerStyle = mobile
    ? {position:"fixed",inset:0,background:"rgba(0,0,0,.6)",zIndex:500,display:"flex",alignItems:"flex-end"}
    : {position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",padding:20};
  const innerStyle = mobile
    ? {background:"white",borderRadius:"20px 20px 0 0",width:"100%",maxHeight:"90vh",overflowY:"auto",padding:"24px 20px 40px"}
    : {background:"white",borderRadius:16,width:"100%",maxWidth:560,maxHeight:"88vh",overflowY:"auto",padding:28};

  return (
    <div style={outerStyle}>
      <div style={innerStyle}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <h2 style={{margin:0,fontSize:20,fontWeight:800,color:C.text,fontFamily:F}}>Add New Property</h2>
          <button onClick={onClose}
            style={{background:C.bg,border:"1px solid "+C.border,borderRadius:"50%",width:32,height:32,
              fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>x</button>
        </div>
        <div style={{marginBottom:14}}>
          <label style={{fontSize:13,color:C.textSub,fontWeight:500,display:"block",marginBottom:5,fontFamily:F}}>Property Address</label>
          <AddressInput value={p.address} onChange={v=>u("address",v)}
            onSelect={loc=>setP(prev=>({...prev,address:loc.address,city:loc.city,state:loc.state,zip:loc.zip,lat:loc.lat,lng:loc.lng}))}
            mobile={mobile} />
        </div>
        <StreetViewImg lat={p.lat} lng={p.lng} address={p.address} height={150} />
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginTop:12,marginBottom:12}}>
          {[["City","city"],["State","state"],["ZIP","zip"]].map(([l,f]) => (
            <div key={f}>
              <label style={{fontSize:12,color:C.textMuted,fontFamily:F,display:"block",marginBottom:4}}>{l}</label>
              <input value={p[f]||""} onChange={e=>u(f,e.target.value)} style={iS(mobile)} />
            </div>
          ))}
        </div>
        <button onClick={runSearch} disabled={loading}
          style={{...btnStyle("primary","md"),width:"100%",marginBottom:12}}>
          {loading ? "Searching..." : "🔍 Run Search"}
        </button>
        {err && <div style={{color:C.red,fontSize:13,marginBottom:10,fontFamily:F}}>{err}</div>}
        <div style={{marginBottom:12}}>
          <label style={{fontSize:13,color:C.textSub,fontWeight:500,display:"block",marginBottom:5,fontFamily:F}}>LLC Owner</label>
          <select value={p.llc} onChange={e=>u("llc",e.target.value)} style={iS(mobile)}>
            {llcs.map(l => <option key={l}>{l}</option>)}
          </select>
        </div>
        <InputField label="Purchase Price $" val={p.purchasePrice||0} set={v=>u("purchasePrice",v)} pre="$" mobile={mobile} />
        <InputField label="Expected Rent $" val={p.rentAmount||0} set={v=>u("rentAmount",v)} pre="$"
          note={p.rentEstimate>0?"Est. "+$(p.rentEstimate)+"/mo":""} mobile={mobile} />
        <button onClick={()=>onAdd(p)}
          style={{...btnStyle("primary","xl"),width:"100%",marginTop:8}}>
          Add to Portfolio
        </button>
      </div>
    </div>
  );
}

// -- Desktop Sidebar -----------------------------------------------------------
function DesktopSidebar({page, setPage, daysLeft}) {
  const items = [
    {id:"dashboard",  icon:"🏠", label:"Dashboard"},
    {id:"properties", icon:"🏘", label:"My Properties"},
    {id:"deal",       icon:"🔍", label:"Deal Analyzer"},
    {id:"comps",      icon:"📊", label:"Lease Comps"},
    {id:"settings",   icon:"*", label:"Settings"},
  ];
  return (
    <div style={{width:220, background:C.sidebar, height:"100vh", position:"fixed",
      left:0, top:0, display:"flex", flexDirection:"column", zIndex:100}}>
      <div style={{padding:"20px 16px 16px", borderBottom:"1px solid rgba(255,255,255,.08)"}}>
        <div style={{display:"flex", alignItems:"center", gap:8}}>
          <div style={{width:34, height:34, background:C.green, borderRadius:10,
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:18}}>🐝</div>
          <div style={{fontSize:20, fontWeight:900, color:"white", fontFamily:F, letterSpacing:"-.02em"}}>
            Deal<span style={{color:C.amber}}>Hive</span>
          </div>
        </div>
        {daysLeft !== null && daysLeft <= TRIAL_DAYS && (
          <div style={{marginTop:10, background:daysLeft<=0?"rgba(239,68,68,.2)":"rgba(245,158,11,.2)",
            borderRadius:8, padding:"6px 10px", fontSize:11, fontFamily:F,
            color:daysLeft<=0?"#fca5a5":"#fde68a", fontWeight:600}}>
            {daysLeft<=0 ? "Trial expired" : "🐝 "+daysLeft+"d trial left"}
          </div>
        )}
      </div>
      <div style={{flex:1, padding:"12px 8px", overflowY:"auto"}}>
        {items.map(item => (
          <button key={item.id} onClick={()=>setPage(item.id)}
            style={{width:"100%", padding:"10px 12px", border:"none", borderRadius:10,
              cursor:"pointer", display:"flex", alignItems:"center", gap:10, marginBottom:2,
              background:page===item.id?C.green:"transparent",
              color:page===item.id?"white":"rgba(255,255,255,.65)",
              fontFamily:F, fontSize:14, fontWeight:page===item.id?600:400, transition:"all .15s"}}>
            <span style={{fontSize:17}}>{item.icon}</span>{item.label}
          </button>
        ))}
      </div>
      <div style={{padding:"12px 16px", borderTop:"1px solid rgba(255,255,255,.08)",
        fontSize:11, color:"rgba(255,255,255,.3)", fontFamily:F}}>
        DealHive v{VERSION} - dealhive.io
      </div>
    </div>
  );
}

// -- Mobile Bottom Nav ---------------------------------------------------------
function MobileNav({page, setPage, alertCount}) {
  const tabs = [
    {id:"dashboard",  icon:"🏠", label:"Home"},
    {id:"properties", icon:"🏘", label:"Properties"},
    {id:"deal",       icon:"🔍", label:"Analyze"},
    {id:"comps",      icon:"📊", label:"Comps"},
    {id:"settings",   icon:"*", label:"More"},
  ];
  return (
    <div style={{position:"fixed", bottom:0, left:0, right:0, background:"white",
      borderTop:"1px solid "+C.border, zIndex:100,
      paddingBottom:"env(safe-area-inset-bottom,8px)", boxShadow:"0 -4px 20px rgba(0,0,0,.08)"}}>
      <div style={{display:"flex", maxWidth:600, margin:"0 auto"}}>
        {tabs.map(t => (
          <button key={t.id} onClick={()=>setPage(t.id)}
            style={{flex:1, padding:"10px 4px 8px", border:"none", background:"none", cursor:"pointer",
              display:"flex", flexDirection:"column", alignItems:"center", gap:3,
              color:page===t.id?C.green:C.textMuted,
              WebkitTapHighlightColor:"transparent", position:"relative"}}>
            <span style={{fontSize:22}}>{t.icon}</span>
            <span style={{fontSize:10, fontWeight:page===t.id?700:500, fontFamily:F}}>{t.label}</span>
            {t.id==="dashboard" && alertCount>0 && (
              <span style={{position:"absolute", top:6, right:"calc(50% - 16px)",
                background:C.red, color:"white", borderRadius:10,
                fontSize:9, padding:"1px 5px", fontWeight:700, fontFamily:F}}>{alertCount}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// -- Mobile Header -------------------------------------------------------------
function MobileHeader({page, onBack, toast, daysLeft}) {
  const showBack = page==="property";
  const titles = {
    dashboard:"Portfolio", properties:"My Properties",
    deal:"Deal Analyzer", comps:"Lease Comps",
    settings:"Settings", property:"Property"
  };
  return (
    <div style={{background:"white", borderBottom:"1px solid "+C.border, padding:"12px 16px",
      position:"sticky", top:0, zIndex:200, boxShadow:"0 1px 6px rgba(0,0,0,.06)",
      display:"flex", alignItems:"center", gap:12}}>
      {showBack ? (
        <button onClick={onBack}
          style={{background:C.bg, border:"1px solid "+C.border, borderRadius:8,
            width:32, height:32, fontSize:18, cursor:"pointer",
            display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0}}><</button>
      ) : (
        <div style={{display:"flex", alignItems:"center", gap:6, flexShrink:0}}>
          <div style={{width:26, height:26, background:C.green, borderRadius:7,
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:14}}>🐝</div>
          <span style={{fontSize:16, fontWeight:900, color:C.text, fontFamily:F, letterSpacing:"-.01em"}}>
            Deal<span style={{color:C.amber}}>Hive</span>
          </span>
        </div>
      )}
      <div style={{flex:1}}>
        <div style={{fontWeight:700, fontSize:15, color:C.text, fontFamily:F}}>{titles[page]||"DealHive"}</div>
        {daysLeft!==null && daysLeft<=TRIAL_DAYS && !showBack && (
          <div style={{fontSize:11, color:daysLeft<=0?C.red:"#92400e", fontFamily:F, fontWeight:600}}>
            {daysLeft<=0 ? "Trial expired" : "🐝 "+daysLeft+"d trial left"}
          </div>
        )}
      </div>
      {toast && <span style={{fontSize:12, color:C.green, fontWeight:700, fontFamily:F}}>{toast}</span>}
    </div>
  );
}

// -- Desktop Top Bar -----------------------------------------------------------
function DesktopTopBar({page, propAddress, toast}) {
  const titles = {
    dashboard:"Portfolio Dashboard", properties:"My Properties",
    deal:"Deal Analyzer", comps:"Lease Comps",
    settings:"Settings", property:propAddress||"Property Detail"
  };
  return (
    <div style={{background:"white", borderBottom:"1px solid "+C.border, padding:"0 32px",
      height:56, display:"flex", alignItems:"center", justifyContent:"space-between",
      position:"sticky", top:0, zIndex:100, boxShadow:"0 1px 4px rgba(0,0,0,.04)"}}>
      <div style={{fontSize:15, fontWeight:700, color:C.text, fontFamily:F}}>{titles[page]||"DealHive"}</div>
      {toast && <span style={{fontSize:13, color:C.green, fontWeight:700, fontFamily:F}}>{toast}</span>}
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

  // Global styles
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap";
    document.head.appendChild(link);
    const style = document.createElement("style");
    style.textContent = [
      "*{box-sizing:border-box;}",
      "body{margin:0;overscroll-behavior:none;}",
      "input::placeholder{color:#9ca3af;}",
      "select{background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236b7280' d='M6 8L1 3h10z'/%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:right 12px center;padding-right:36px;}",
      "input[type=range]{-webkit-appearance:none;height:6px;border-radius:3px;background:#e5e7eb;outline:none;}",
      "input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;cursor:pointer;}",
    ].join("");
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

  // Loading screen
  if (authLoading) return (
    <div style={{minHeight:"100vh", background:C.sidebar,
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16}}>
      <div style={{fontSize:48}}>🐝</div>
      <div style={{fontSize:28, fontWeight:900, color:"white", fontFamily:F}}>
        Deal<span style={{color:C.amber}}>Hive</span>
      </div>
      <div style={{fontSize:14, color:"rgba(255,255,255,.5)", fontFamily:F}}>Loading...</div>
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
  };

  // Mobile layout
  if (mobile) return (
    <div style={{fontFamily:F, background:C.bg, minHeight:"100vh", maxWidth:600, margin:"0 auto"}}>
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
        ) : page==="deal" ? (
          <DealAnalyzer deals={data.deals||[]} onSave={saveDeals} onMoveToPortfolio={moveDealToPortfolio} {...sharedProps} />
        ) : page==="comps" ? (
          <LeaseComps rentcastKey={data.rentcastKey||""} onSaveKey={saveRCKey} mobile={mobile} />
        ) : page==="settings" ? (
          <SettingsPage llcs={data.llcs||[]} renoRates={data.renoRates||SEED.renoRates}
            onSave={(l,r)=>persist({...data,llcs:l,renoRates:r})}
            onSignOut={handleSignOut} mobile={mobile} userEmail={user.email} />
        ) : null}
      </ErrorBoundary>
      <MobileNav page={showProp?"dashboard":page} setPage={p=>{setPage(p);setPropId(null);}} alertCount={alerts} />
      {showAdd && <AddPropertyModal llcs={data.llcs||[]} onAdd={addProp} onClose={()=>setShowAdd(false)} {...sharedProps} />}
    </div>
  );

  // Desktop layout
  return (
    <div style={{fontFamily:F, background:C.bg, minHeight:"100vh", display:"flex"}}>
      <DesktopSidebar page={showProp?"properties":page} setPage={p=>{setPage(p);setPropId(null);}} daysLeft={daysLeft} />
      <div style={{marginLeft:220, flex:1, minWidth:0}}>
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
            ) : page==="deal" ? (
              <DealAnalyzer deals={data.deals||[]} onSave={saveDeals} onMoveToPortfolio={moveDealToPortfolio} {...sharedProps} />
            ) : page==="comps" ? (
              <LeaseComps rentcastKey={data.rentcastKey||""} onSaveKey={saveRCKey} mobile={mobile} />
            ) : page==="settings" ? (
              <SettingsPage llcs={data.llcs||[]} renoRates={data.renoRates||SEED.renoRates}
                onSave={(l,r)=>persist({...data,llcs:l,renoRates:r})}
                onSignOut={handleSignOut} mobile={mobile} userEmail={user.email} />
            ) : null}
          </ErrorBoundary>
        </div>
      </div>
      {showAdd && <AddPropertyModal llcs={data.llcs||[]} onAdd={addProp} onClose={()=>setShowAdd(false)} {...sharedProps} />}
    </div>
  );
}
