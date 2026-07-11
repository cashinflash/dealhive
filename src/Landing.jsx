// DealHive marketing site — public pages at dealhive.io.
//
// Multi-page (DealCheck-style structure), single design system:
//   /          Home
//   /features  Product tour + strategy sections
//   /pricing   Plans
//   /faq       Full FAQ
//   /about     Mission / story
//   /contact   Support
//   /privacy   Privacy Policy   (also reachable while signed in)
//   /terms     Terms of Use     (also reachable while signed in)
//
// Routing lives in App.jsx (path state + pushState); this file just renders
// the page it's told to. Self-contained: no imports from App.jsx so the
// marketing surface stays decoupled from the 400KB app bundle.

import { useEffect, useState } from "react";

// -- Brand tokens (mirrors App.jsx C palette) ---------------------------------
const C = {
  orange:       "#E8731C",
  orangeHover:  "#CC5F12",
  orangeDark:   "#C2410C",
  orangeLight:  "#FFEDD5",
  orangeSubtle: "#FFF7ED",
  orangeBorder: "#FDBA74",
  navy:         "#1F2D3D",
  navyDeep:     "#15212E",
  navySoft:     "#2C3E52",
  text:         "#1F2D3D",
  textSub:      "#52525b",
  textMuted:    "#a1a1aa",
  bg:           "#ffffff",
  bgSoft:       "#fafafa",
  card:         "#ffffff",
  border:       "#e4e4e7",
  borderSoft:   "#f1f1f3",
  cashPos:      "#059669",
};
const F = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

// -- Tiny icon set (inline SVG, no deps) --------------------------------------
const Icon = ({ d, size = 18, stroke = 1.8, fill = "none", style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill}
    stroke="currentColor" strokeWidth={stroke} strokeLinecap="round"
    strokeLinejoin="round" style={style}>{d}</svg>
);
const I = {
  bolt:    <Icon d={<path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>}/>,
  search:  <Icon d={<><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></>}/>,
  chart:   <Icon d={<><path d="M3 20h18"/><path d="M7 16V8m5 8V4m5 12v-6"/></>}/>,
  star:    <Icon d={<path d="M12 3l2.7 5.5 6 .9-4.4 4.3 1 6-5.3-2.8L6.7 19.7l1-6L3.3 9.4l6-.9z"/>}/>,
  shield:  <Icon d={<path d="M12 3l8 3v7c0 4.5-3.4 8.6-8 9.5C7.4 21.6 4 17.5 4 13V6z"/>}/>,
  device:  <Icon d={<><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></>}/>,
  check:   <Icon d={<path d="M5 12l5 5L20 7"/>}/>,
  arrow:   <Icon d={<path d="M5 12h14M13 5l7 7-7 7"/>}/>,
  play:    <Icon d={<path d="M8 5v14l11-7z"/>} fill="currentColor" stroke="none"/>,
  menu:    <Icon d={<><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></>}/>,
  close:   <Icon d={<><path d="M6 6l12 12"/><path d="M18 6L6 18"/></>}/>,
  plus:    <Icon d={<><path d="M12 5v14"/><path d="M5 12h14"/></>}/>,
  minus:   <Icon d={<path d="M5 12h14"/>}/>,
  home:    <Icon d={<><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></>}/>,
  brrrr:   <Icon d={<><path d="M3 13h18"/><path d="M5 9h14M5 17h14"/></>}/>,
  mail:    <Icon d={<><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></>}/>,
};

// -- Small composable bits ----------------------------------------------------
function Button({ children, onClick, variant = "primary", size = "md", style, ...rest }) {
  const sizes = {
    md: { padding: "10px 18px", fontSize: 14, borderRadius: 8 },
    lg: { padding: "14px 24px", fontSize: 15, borderRadius: 10 },
  };
  const variants = {
    primary: {
      background: C.orange, color: "#fff", border: "1px solid " + C.orange,
      boxShadow: "0 1px 2px 0 rgba(232,115,28,.25), 0 0 0 1px rgba(232,115,28,.1) inset",
    },
    secondary: {
      background: "#fff", color: C.text, border: "1px solid " + C.border,
    },
    ghost: { background: "transparent", color: C.text, border: "1px solid transparent" },
    dark: { background: C.navy, color: "#fff", border: "1px solid " + C.navy },
  };
  return (
    <button onClick={onClick}
      style={{
        ...sizes[size], ...variants[variant], ...style,
        display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 600,
        fontFamily: F, cursor: "pointer", letterSpacing: "-0.005em",
        transition: "transform .12s ease, box-shadow .12s ease, background .12s ease",
      }}
      onMouseDown={e => (e.currentTarget.style.transform = "translateY(1px)")}
      onMouseUp={e => (e.currentTarget.style.transform = "translateY(0)")}
      onMouseLeave={e => (e.currentTarget.style.transform = "translateY(0)")}
      {...rest}>
      {children}
    </button>
  );
}

function Eyebrow({ children }) {
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 8,
      padding: "6px 12px", borderRadius: 9999, background: C.orangeSubtle,
      border: "1px solid " + C.orangeBorder, color: C.orangeDark,
      fontSize: 12, fontWeight: 600, fontFamily: F, letterSpacing: "0.02em",
      textTransform: "uppercase",
    }}>
      {children}
    </div>
  );
}

function Section({ children, dark, tint, style, id, hexes }) {
  return (
    <section id={id} className="dh-section" style={{
      padding: "80px 24px",
      position: "relative", overflow: "hidden",
      background: dark ? C.navyDeep : tint ? C.orangeSubtle : C.bg,
      color: dark ? "#fff" : C.text,
      borderTop: tint ? "1px solid " + C.orangeBorder : "none",
      borderBottom: tint ? "1px solid " + C.orangeBorder : "none",
      ...style,
    }}>
      {hexes && (
        <div aria-hidden="true" style={{ position: "absolute", inset: 0, zIndex: 0 }}>
          {hexes.map((h, i) => <Hex key={i} {...h}/>)}
        </div>
      )}
      <div style={{ maxWidth: 1180, margin: "0 auto", position: "relative", zIndex: 1 }}>{children}</div>
    </section>
  );
}

// Soft hive-shaped (rounded hexagon) background blob. The fat stroke with
// round joins is what rounds the corners; `float` picks one of three gentle
// bob animations defined in the root style block.
function Hex({ size = 120, color = C.orangeLight, opacity = 0.5, outline = false,
               blur = 0, float: floatAnim = 1, style }) {
  return (
    <svg width={size} height={size * 1.15} viewBox="0 0 100 115" aria-hidden="true"
      style={{
        position: "absolute", pointerEvents: "none",
        opacity,
        filter: blur ? `blur(${blur}px)` : "none",
        animation: `dhFloat${floatAnim} ${9 + floatAnim * 2.5}s ease-in-out infinite alternate`,
        ...style,
      }}>
      <polygon points="50,6 94,31 94,84 50,109 6,84 6,31"
        fill={outline ? "none" : color}
        stroke={color} strokeWidth="11" strokeLinejoin="round"/>
    </svg>
  );
}

// Preset hex arrangements so every section shares the same motif without
// hand-placing each blob. a/b alternate sides on light sections; dark and
// tint are tuned for the navy and orange-subtle backgrounds.
const HEX_SETS = {
  a: [
    { size: 180, color: C.orangeLight,  opacity: 0.5,  blur: 28, float: 2, style: { top: -60, left: -50 } },
    { size: 84,  color: C.orangeBorder, opacity: 0.32, outline: true, float: 1, style: { top: "20%", right: "3%" } },
    { size: 46,  color: C.orange,       opacity: 0.13, float: 3, style: { bottom: "12%", right: "9%" } },
  ],
  b: [
    { size: 210, color: C.orangeLight,  opacity: 0.5,  blur: 32, float: 1, style: { bottom: -80, right: -60 } },
    { size: 92,  color: C.orangeBorder, opacity: 0.32, outline: true, float: 3, style: { top: "12%", left: "2.5%" } },
    { size: 42,  color: C.orange,       opacity: 0.14, float: 2, style: { top: "42%", left: "8%" } },
  ],
  dark: [
    { size: 280, color: C.orange, opacity: 0.12, blur: 42, float: 1, style: { top: -90, right: "6%" } },
    { size: 110, color: "#ffffff", opacity: 0.10, outline: true, float: 2, style: { bottom: -34, left: "5%" } },
    { size: 54,  color: C.orange, opacity: 0.18, float: 3, style: { top: "28%", left: "13%" } },
  ],
  tint: [
    { size: 230, color: "#ffffff", opacity: 0.65, blur: 36, float: 2, style: { top: -80, left: "6%" } },
    { size: 104, color: C.orangeBorder, opacity: 0.38, outline: true, float: 1, style: { bottom: "8%", right: "4%" } },
    { size: 48,  color: C.orange, opacity: 0.14, float: 3, style: { top: "30%", right: "12%" } },
  ],
  // Richer spread for sections whose big white cards swallow the subtle sets.
  how: [
    { size: 260, color: C.orangeLight,  opacity: 0.55, blur: 34, float: 1, style: { top: -80, left: -70 } },
    { size: 120, color: C.orangeBorder, opacity: 0.4,  outline: true, float: 2, style: { top: "6%", right: "8%" } },
    { size: 56,  color: C.orange,       opacity: 0.16, float: 3, style: { top: "38%", left: "31%" } },
    { size: 90,  color: C.orangeBorder, opacity: 0.35, outline: true, float: 1, style: { bottom: "10%", left: "4%" } },
    { size: 220, color: C.orangeLight,  opacity: 0.5,  blur: 30, float: 2, style: { bottom: -70, right: -50 } },
    { size: 48,  color: C.orange,       opacity: 0.15, float: 1, style: { bottom: "30%", right: "30%" } },
  ],
};

function SectionHeader({ eyebrow, title, subtitle, dark, center = true }) {
  return (
    <div className="dh-sec-head" style={{ textAlign: center ? "center" : "left", marginBottom: 56, maxWidth: 720, margin: center ? "0 auto 56px" : "0 0 56px" }}>
      {eyebrow && <div style={{ marginBottom: 16 }}><Eyebrow>{eyebrow}</Eyebrow></div>}
      <h2 style={{
        fontSize: "clamp(28px, 4.2vw, 44px)", fontWeight: 700, fontFamily: F,
        letterSpacing: "-0.03em", lineHeight: 1.1, margin: "0 0 16px",
        color: dark ? "#fff" : C.text,
      }}>
        {title}
      </h2>
      {subtitle && (
        <p style={{
          fontSize: "clamp(15px, 1.6vw, 18px)", color: dark ? "rgba(255,255,255,.7)" : C.textSub,
          fontFamily: F, margin: 0, lineHeight: 1.6,
        }}>
          {subtitle}
        </p>
      )}
    </div>
  );
}

// Compact hero for subpages (Features, Pricing, FAQ, …).
function PageHero({ eyebrow, title, subtitle }) {
  return (
    <section className="dh-page-hero" style={{
      padding: "64px 24px 56px",
      position: "relative", overflow: "hidden",
      background: `radial-gradient(ellipse at 50% 0%, ${C.orangeSubtle} 0%, transparent 60%), ${C.bg}`,
      textAlign: "center",
    }}>
      <div aria-hidden="true" style={{ position: "absolute", inset: 0, zIndex: 0 }}>
        <Hex size={220} color={C.orangeLight} opacity={0.5} blur={34} float={1}
          style={{ top: -70, right: "4%" }}/>
        <Hex size={96} color={C.orangeBorder} opacity={0.35} outline float={2}
          style={{ top: "22%", left: "-28px" }}/>
        <Hex size={48} color={C.orange} opacity={0.15} float={3}
          style={{ bottom: "8%", right: "16%" }}/>
      </div>
      <div style={{ maxWidth: 760, margin: "0 auto", position: "relative", zIndex: 1 }}>
        {eyebrow && <div style={{ marginBottom: 16 }}><Eyebrow>{eyebrow}</Eyebrow></div>}
        <h1 style={{
          fontSize: "clamp(32px, 5vw, 52px)", fontWeight: 700, fontFamily: F,
          letterSpacing: "-0.035em", lineHeight: 1.05, margin: "0 0 16px", color: C.text,
        }}>
          {title}
        </h1>
        {subtitle && (
          <p style={{
            fontSize: "clamp(15px, 1.7vw, 18px)", color: C.textSub, fontFamily: F,
            margin: 0, lineHeight: 1.6,
          }}>
            {subtitle}
          </p>
        )}
      </div>
    </section>
  );
}

// -- Mock deal card used in the hero ------------------------------------------
// `photo` is the gradient fallback (shown if `imgUrl` fails or while loading);
// `imgUrl` is the real photo (Unsplash, hosted, whatever). Swap imgUrls in
// HeroVisual below to change which photos appear in the hero.
function MockDealCard({ photo, imgUrl, imgFallbackUrl, address, price, rent, capRate, cashflow, beds, baths, sqft, badge, stats }) {
  const [imgFailed, setImgFailed] = useState(false);
  const [useFallbackImg, setUseFallbackImg] = useState(false);
  const activeImg = useFallbackImg ? imgFallbackUrl : imgUrl;
  return (
    <div style={{
      background: "#fff", borderRadius: 14, overflow: "hidden",
      border: "1px solid " + C.border,
      boxShadow: "0 20px 40px -12px rgba(15,23,42,.18), 0 8px 16px -8px rgba(15,23,42,.08)",
      fontFamily: F,
    }}>
      <div style={{
        height: 160, background: `linear-gradient(135deg, ${photo[0]} 0%, ${photo[1]} 100%)`,
        position: "relative", overflow: "hidden",
      }}>
        {activeImg && !imgFailed && (
          <img src={activeImg} alt=""
            loading="lazy" decoding="async"
            onError={() => { if (!useFallbackImg && imgFallbackUrl) setUseFallbackImg(true); else setImgFailed(true); }}
            style={{
              position: "absolute", inset: 0, width: "100%", height: "100%",
              objectFit: "cover", display: "block",
            }}/>
        )}
        {badge && (
          <div style={{
            position: "absolute", top: 12, left: 12,
            background: "rgba(255,255,255,.95)", padding: "5px 10px", borderRadius: 9999,
            fontSize: 11, fontWeight: 700, color: C.orangeDark, letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}>
            {badge}
          </div>
        )}
        <div style={{
          position: "absolute", bottom: 12, right: 12,
          background: "rgba(31,45,61,.85)", color: "#fff", padding: "4px 10px",
          borderRadius: 6, fontSize: 11, fontWeight: 600,
        }}>
          {beds}bd · {baths}ba · {sqft}sqft
        </div>
      </div>
      <div style={{ padding: 14 }}>
        <div style={{ fontSize: 13, color: C.textSub, marginBottom: 2 }}>{address}</div>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", color: C.text }}>
          ${price.toLocaleString()}
        </div>
        <div style={{
          marginTop: 12, paddingTop: 12, borderTop: "1px solid " + C.borderSoft,
          display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8,
        }}>
          {(stats || [
            { label: "Rent", value: "$" + rent },
            { label: "Cap rate", value: capRate + "%", accent: true },
            { label: "Cash flow", value: "$" + cashflow + "/mo", accent: true },
          ]).map(st => (
            <Stat key={st.label} label={st.label} value={st.value} accent={st.accent} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: accent ? C.cashPos : C.text, marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

// -- Phone mockup with stacked deal cards -------------------------------------
function HeroVisual() {
  return (
    <div className="dh-hv-tilt" style={{
      position: "relative",
      transform: "perspective(1400px) rotateY(-7deg) rotateX(3deg)",
      transformOrigin: "center center",
    }}>
      <div style={{
        position: "absolute", top: -40, right: -40, bottom: -40, left: -40,
        background: `radial-gradient(closest-side, ${C.orangeSubtle}, transparent 70%)`,
        filter: "blur(20px)", zIndex: 0,
      }}/>
      <div style={{ position: "relative", zIndex: 1, display: "grid", gap: 18 }}>
        <MockDealCard
          photo={["#fef3c7", "#fde68a"]}
          imgUrl="https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=720&h=400&q=80"
          address="Cleveland, OH 44109"
          price={84500} rent={1450} capRate={14.2} cashflow={612}
          beds={3} baths={1} sqft={1240}
          badge="Buy & Hold"
        />
        <div className="dh-hv-b" style={{ transform: "translateX(40px)" }}>
          <MockDealCard
            photo={["#dbeafe", "#bfdbfe"]}
            imgUrl="https://images.unsplash.com/photo-1564013799919-ab600027ffc6?auto=format&fit=crop&w=720&h=400&q=80"
            address="Detroit, MI 48227"
            price={62000}
            beds={3} baths={2} sqft={1380}
            badge="BRRRR"
            stats={[
              { label: "Rent", value: "$1,350" },
              { label: "Cash-Out Refi", value: "$99,200", accent: true },
              { label: "Cash flow", value: "$744/mo", accent: true },
            ]}
          />
        </div>
        <div className="dh-hv-c" style={{ transform: "translateX(-30px)" }}>
          <MockDealCard
            photo={["#e0e7ff", "#c7d2fe"]}
            imgUrl="/flip-house.jpg"
            imgFallbackUrl="https://images.unsplash.com/photo-1518780664697-55e3ad937233?auto=format&fit=crop&w=720&h=400&q=80"
            address="Memphis, TN 38106"
            price={75000}
            beds={3} baths={1} sqft={1180}
            badge="Fix & Flip"
            stats={[
              { label: "Purchase", value: "$75,000" },
              { label: "Repairs", value: "$22,000" },
              { label: "Total Profit", value: "$34,500", accent: true },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

// -- Top nav ------------------------------------------------------------------
const NAV_LINKS = [
  ["Features", "/features"],
  ["Pricing", "/pricing"],
  ["FAQ", "/faq"],
  ["About", "/about"],
];

function TopNav({ navigate, onSignIn, onSignUp }) {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const go = p => { setMobileOpen(false); navigate(p); };
  return (
    <nav style={{
      position: "sticky", top: 0, zIndex: 50,
      background: scrolled ? "rgba(255,255,255,.85)" : "rgba(255,255,255,.6)",
      backdropFilter: "saturate(180%) blur(14px)",
      WebkitBackdropFilter: "saturate(180%) blur(14px)",
      borderBottom: "1px solid " + (scrolled ? C.border : "transparent"),
      transition: "background .2s ease, border-color .2s ease",
      fontFamily: F,
    }}>
      <div style={{
        maxWidth: 1180, margin: "0 auto",
        padding: "14px 24px",
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24,
      }}>
        <a href="/" onClick={e => { e.preventDefault(); go("/"); }}
          style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
          <img src="/logo.png" alt="DealHive" style={{ height: 40, width: "auto" }}/>
        </a>

        <div style={{ display: "flex", alignItems: "center", gap: 32 }} className="dh-nav-links">
          {NAV_LINKS.map(([label, path]) => (
            <a key={path} href={path} onClick={e => { e.preventDefault(); go(path); }}
              style={{
                color: C.text, fontSize: 14, fontWeight: 500, fontFamily: F,
                letterSpacing: "-0.005em", textDecoration: "none", cursor: "pointer",
              }}>
              {label}
            </a>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={onSignIn} className="dh-nav-signin"
            style={{
              background: "transparent", border: "none", padding: "8px 12px", cursor: "pointer",
              color: C.text, fontSize: 14, fontWeight: 500, fontFamily: F,
            }}>
            Log in
          </button>
          <Button onClick={onSignUp} size="md">Get started</Button>
          <button onClick={() => setMobileOpen(v => !v)} className="dh-nav-burger" aria-label="Menu"
            style={{
              background: "transparent", border: "none", padding: 8, cursor: "pointer",
              color: C.text, display: "none",
            }}>
            {mobileOpen ? I.close : I.menu}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div onClick={e => e.target === e.currentTarget && setMobileOpen(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 90,
            background: "rgba(15,23,42,.45)",
            backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
            animation: "dhMenuFade .18s ease",
          }}>
          <div style={{
            borderRadius: "0 0 22px 22px", overflow: "hidden",
            boxShadow: "0 30px 60px -20px rgba(15,23,42,.5)",
            animation: "dhMenuSlide .22s cubic-bezier(.2,.9,.3,1)",
          }}>
            <div style={{display:"flex", justifyContent:"space-between", alignItems:"center",
              background:"#fff", padding:"14px 20px"}}>
              <img src="/logo.png" alt="DealHive" style={{ height: 40, width: "auto" }}/>
              <button onClick={() => setMobileOpen(false)} aria-label="Close menu"
                style={{width:38, height:38, borderRadius:12, background:C.bgSoft,
                  border:"1px solid "+C.border, cursor:"pointer", color:C.text,
                  display:"flex", alignItems:"center", justifyContent:"center"}}>
                {I.close}
              </button>
            </div>
            <div style={{
              background: `radial-gradient(ellipse at 50% 0%, ${C.navySoft} 0%, ${C.navyDeep} 75%)`,
              padding: "8px 20px 24px",
            }}>
              {NAV_LINKS.map(([label, path], i) => (
                <a key={path} href={path} onClick={e => { e.preventDefault(); go(path); }}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "16px 4px", fontFamily: F, fontSize: 17, fontWeight: 600,
                    color: "#fff", textDecoration: "none", letterSpacing: "-0.01em",
                    borderBottom: i < NAV_LINKS.length - 1 ? "1px solid rgba(255,255,255,.14)" : "none",
                  }}>
                  {label}
                  <span style={{color: C.orange, display:"inline-flex"}}>{I.arrow}</span>
                </a>
              ))}
              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:20}}>
                <button onClick={() => { setMobileOpen(false); onSignIn(); }}
                  style={{
                    padding:"13px 18px", borderRadius:10, fontFamily:F, fontSize:15, fontWeight:600,
                    background:"rgba(255,255,255,.08)", color:"#fff",
                    border:"1px solid rgba(255,255,255,.28)", cursor:"pointer",
                  }}>Log in</button>
                <Button onClick={() => { setMobileOpen(false); onSignUp(); }} size="lg"
                  style={{justifyContent:"center"}}>Get started</Button>
              </div>
            </div>
          </div>
          <style>{`
            @keyframes dhMenuFade { from { opacity: 0 } to { opacity: 1 } }
            @keyframes dhMenuSlide { from { transform: translateY(-14px); opacity: .4 } to { transform: translateY(0); opacity: 1 } }
          `}</style>
        </div>
      )}

      <style>{`
        @media (max-width: 760px) {
          .dh-nav-links { display: none !important; }
          .dh-nav-signin { display: none !important; }
          .dh-nav-burger { display: inline-flex !important; }
        }
      `}</style>
    </nav>
  );
}

// -- Hero ---------------------------------------------------------------------
function Hero({ onSignUp }) {
  return (
    <section className="dh-hero" style={{
      position: "relative", overflow: "hidden",
      padding: "72px 24px 96px",
      background: `radial-gradient(ellipse at 80% 0%, ${C.orangeSubtle} 0%, transparent 50%), ${C.bg}`,
    }}>
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 1,
        background: `linear-gradient(90deg, transparent, ${C.border}, transparent)`,
      }}/>

      {/* Hive blobs — decorative rounded hexagons floating behind the content */}
      <div aria-hidden="true" style={{ position: "absolute", inset: 0, zIndex: 0 }}>
        <Hex size={340} color={C.orangeLight} opacity={0.55} blur={46} float={1}
          style={{ top: -90, right: -70 }}/>
        <Hex size={120} color={C.orangeBorder} opacity={0.42} outline float={3}
          style={{ top: "4%", right: "-34px" }}/>
        <Hex size={58} color={C.orange} opacity={0.18} float={2}
          style={{ top: "15%", right: "10%" }}/>
        <Hex size={150} color={C.orangeBorder} opacity={0.35} outline float={2}
          style={{ top: "16%", left: "-46px" }}/>
        <Hex size={64} color={C.orange} opacity={0.16} float={3}
          style={{ top: "9%", left: "38%" }}/>
        <Hex size={210} color={C.orangeLight} opacity={0.5} blur={30} float={2}
          style={{ bottom: -70, left: "12%" }}/>
        <Hex size={90} color={C.orangeBorder} opacity={0.4} outline float={1}
          style={{ bottom: "14%", right: "40%" }}/>
        <Hex size={44} color={C.orange} opacity={0.2} float={2}
          style={{ bottom: "26%", right: "44.5%" }}/>
      </div>

      <div style={{
        maxWidth: 1180, margin: "0 auto",
        display: "grid", gridTemplateColumns: "1.05fr 1fr", gap: 64, alignItems: "center",
        position: "relative", zIndex: 1,
      }} className="dh-hero-grid">
        <div className="dh-hero-copy">
          <div style={{ marginBottom: 24 }}>
            <Eyebrow>Any address, any strategy, in seconds</Eyebrow>
          </div>
          <h1 style={{
            fontSize: "clamp(44px, 6.4vw, 70px)", fontWeight: 700, fontFamily: F,
            letterSpacing: "-0.035em", lineHeight: 1.02, margin: "0 0 22px",
            color: C.text,
          }}>
            Analyze any investment{" "}
            <span style={{
              background: `linear-gradient(135deg, ${C.orange} 0%, ${C.orangeDark} 100%)`,
              WebkitBackgroundClip: "text", backgroundClip: "text",
              WebkitTextFillColor: "transparent", color: "transparent",
            }}>
              <span style={{ whiteSpace: "nowrap" }}>in seconds.</span>
            </span>
          </h1>
          <p style={{
            fontSize: "clamp(16px, 1.7vw, 19px)", color: C.textSub, fontFamily: F,
            lineHeight: 1.55, margin: "0 0 32px", maxWidth: 540,
          }}>
            Enter an address. DealHive pulls the data, runs Buy & Hold, BRRRR, and Fix & Flip, and tells you which one wins.
          </p>
          <div className="dh-hero-ctas" style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 32 }}>
            <Button onClick={onSignUp} size="lg">
              Get started free {I.arrow}
            </Button>
            <Button onClick={() => document.getElementById("how")?.scrollIntoView({ behavior: "smooth" })}
              variant="secondary" size="lg">
              {I.play} See how it works
            </Button>
          </div>
          <div className="dh-hero-checks" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            {["No credit card", "Free tier forever", "Cancel anytime"].map(t => (
              <span key={t} style={{
                display: "inline-flex", alignItems: "center", gap: 7,
                padding: "7px 13px", borderRadius: 9999,
                background: "#fff", border: "1px solid " + C.border,
                boxShadow: "0 1px 2px rgba(15,23,42,.05)",
                fontSize: 12.5, fontWeight: 600, color: C.textSub, fontFamily: F,
              }}>
                <span style={{ color: C.cashPos, display: "inline-flex" }}>{I.check}</span> {t}
              </span>
            ))}
          </div>
        </div>

        <div className="dh-hero-visual">
          <HeroVisual/>
        </div>
      </div>

      <style>{`
        @media (max-width: 920px) {
          .dh-hero-grid { grid-template-columns: 1fr !important; gap: 48px !important; }
          .dh-hero-visual { max-width: 380px; margin: 0 auto; width: 100%; }
          .dh-hero-copy { text-align: center; }
          .dh-hero-copy p { margin-left: auto !important; margin-right: auto !important; }
          .dh-hero-ctas { justify-content: center; }
          .dh-hero-checks { justify-content: center !important; }
        }
      `}</style>
    </section>
  );
}

// -- Trust bar (markets covered) ----------------------------------------------
function TrustBar() {
  const chips = [
    { icon: I.home,   label: "Buy & Hold analysis" },
    { icon: I.brrrr,  label: "BRRRR & refi modeling" },
    { icon: I.chart,  label: "Fix & Flip profits" },
    { icon: I.bolt,   label: "Live property data built in" },
  ];
  return (
    <section style={{
      padding: "32px 24px", borderTop: "1px solid " + C.border, borderBottom: "1px solid " + C.border,
      background: C.bgSoft,
    }}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <div style={{
          fontSize: "clamp(17px, 2.2vw, 22px)", fontWeight: 700, color: C.navy, fontFamily: F,
          letterSpacing: "-0.015em", textAlign: "center", marginBottom: 20,
        }}>
          Built for real estate investors, coast to coast
        </div>
        <div className="dh-trust-grid" style={{
          display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12,
          maxWidth: 980, margin: "0 auto",
        }}>
          {chips.map(c => (
            <div key={c.label} style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
              padding: "13px 14px", background: "#fff",
              border: "1px solid " + C.border, borderRadius: 12,
              boxShadow: "0 1px 2px rgba(15,23,42,.05)",
              fontSize: 13.5, fontWeight: 600, color: C.navy, fontFamily: F,
              textAlign: "center",
            }}>
              <span style={{
                width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                background: C.orangeSubtle, border: "1px solid " + C.orangeBorder, color: C.orangeDark,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
              }}>{c.icon}</span>
              <span>{c.label}</span>
            </div>
          ))}
        </div>
        <style>{`
          @media (max-width: 860px) {
            .dh-trust-grid { grid-template-columns: repeat(2, 1fr) !important; }
          }
          @media (max-width: 420px) {
            .dh-trust-grid { grid-template-columns: 1fr !important; }
          }
        `}</style>
      </div>
    </section>
  );
}

// -- How it works -------------------------------------------------------------
function HowItWorks() {
  const steps = [
    {
      n: "01",
      title: "Enter any address",
      body: "Beds, baths, square footage, taxes, home value, and market rent fill in automatically from live property records. No spreadsheet setup, no manual research.",
    },
    {
      n: "02",
      title: "Pick your strategy",
      body: "Cash or financed. Buy & Hold, BRRRR, or Fix & Flip. Real financing options too: multiple loans, interest-only, rehab loans, even properties you already own.",
    },
    {
      n: "03",
      title: "Get the verdict",
      body: "Cash flow, cap rate, refi proceeds, flip profit, and a clear recommendation on which exit wins. Save the analysis and it's waiting on your dashboard.",
    },
  ];
  return (
    <Section id="how" hexes={HEX_SETS.how}>
      <SectionHeader
        eyebrow="How it works"
        title="From address to answer in three steps."
        subtitle="DealHive does the research and the math. You make the decision."
      />
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 24,
      }}>
        {steps.map(s => (
          <div key={s.n} style={{
            padding: 28, background: "#fff", border: "1px solid " + C.border, borderRadius: 16,
            position: "relative", overflow: "hidden",
          }}>
            <div style={{
              fontSize: 56, fontWeight: 800, fontFamily: F, letterSpacing: "-0.04em",
              lineHeight: 1, marginBottom: 14,
              background: `linear-gradient(135deg, ${C.orange} 0%, ${C.orangeBorder} 100%)`,
              WebkitBackgroundClip: "text", backgroundClip: "text",
              WebkitTextFillColor: "transparent", color: "transparent", opacity: .9,
            }}>
              {s.n}
            </div>
            <h3 style={{
              fontSize: 19, fontWeight: 700, fontFamily: F, letterSpacing: "-0.02em",
              margin: "0 0 10px", color: C.text,
            }}>
              {s.title}
            </h3>
            <p style={{ fontSize: 14, color: C.textSub, fontFamily: F, lineHeight: 1.6, margin: 0 }}>
              {s.body}
            </p>
          </div>
        ))}
      </div>
    </Section>
  );
}

// -- Features grid ------------------------------------------------------------
const FEATURES = [
  { icon: I.bolt,   title: "Analysis in seconds",
    body: "Type an address and the property details, taxes, and market rent fill themselves in. Change any number and everything recalculates instantly." },
  { icon: I.brrrr,  title: "Three strategies, one verdict",
    body: "Every property scored as a Buy & Hold, a BRRRR, and a Fix & Flip, with a clear recommendation on which exit wins and why." },
  { icon: I.search, title: "Live property data built in",
    body: "Records on 140M+ U.S. properties: beds, baths, square footage, tax bills, home values, and rent estimates. No API keys, no tab-hopping." },
  { icon: I.chart,  title: "Comps that actually match",
    body: "Rental and sale comps for any address, right inside the analyzer. See what the market really pays, not what Zillow guesses." },
  { icon: I.home,   title: "Financing modeled like real life",
    body: "Multiple loans, interest-only, rehab financing, itemized closing costs rolled into the loan, and equity analysis for properties you already own." },
  { icon: I.star,   title: "A deal feed, included",
    body: "Want inspiration? A feed of investor-friendly and off-market listings is one tap away, each one pre-scored by the same engine." },
];

function Features({ eyebrow = "Features" }) {
  return (
    <Section id="features" style={{ background: C.bgSoft }} hexes={HEX_SETS.b}>
      <SectionHeader
        eyebrow={eyebrow}
        title="Everything you need to underwrite with confidence."
        subtitle="Not a CRM. Not a course. An analysis tool built by investors for investors."
      />
      <div className="dh-feat-grid" style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14,
        maxWidth: 860, margin: "0 auto",
      }}>
        {FEATURES.map(f => (
          <div key={f.title} style={{
            display: "flex", alignItems: "center", gap: 14,
            padding: "18px 20px", background: "#fff",
            border: "1px solid " + C.border, borderRadius: 14,
            transition: "transform .15s ease, box-shadow .15s ease, border-color .15s ease",
          }}
          onMouseEnter={e => {
            e.currentTarget.style.transform = "translateY(-2px)";
            e.currentTarget.style.boxShadow = "0 12px 24px -8px rgba(15,23,42,.08)";
            e.currentTarget.style.borderColor = C.orangeBorder;
          }}
          onMouseLeave={e => {
            e.currentTarget.style.transform = "translateY(0)";
            e.currentTarget.style.boxShadow = "none";
            e.currentTarget.style.borderColor = C.border;
          }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12, flexShrink: 0,
              background: C.orangeSubtle, border: "1px solid " + C.orangeBorder, color: C.orangeDark,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {f.icon}
            </div>
            <h3 style={{
              fontSize: 15.5, fontWeight: 700, fontFamily: F, letterSpacing: "-0.015em",
              margin: 0, color: C.text, lineHeight: 1.3,
            }}>
              {f.title}
            </h3>
          </div>
        ))}
      </div>
      <style>{`
        @media (max-width: 560px) {
          .dh-feat-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </Section>
  );
}

// -- Big "by the numbers" strip ----------------------------------------------
function NumbersStrip() {
  const stats = [
    { v: "<10s",  l: "From address to analysis" },
    { v: "3",     l: "Strategies on every run" },
    { v: "140M+", l: "U.S. property records" },
    { v: "$0",    l: "To get started" },
  ];
  return (
    <Section dark style={{ padding: "64px 24px" }} hexes={HEX_SETS.dark}>
      <div className="dh-numbers" style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 32,
        textAlign: "center",
      }}>
        {stats.map(s => (
          <div key={s.l}>
            <div style={{
              fontSize: "clamp(36px, 5vw, 52px)", fontWeight: 700, fontFamily: F,
              letterSpacing: "-0.035em", lineHeight: 1,
              background: `linear-gradient(135deg, ${C.orange} 0%, #FFB870 100%)`,
              WebkitBackgroundClip: "text", backgroundClip: "text",
              WebkitTextFillColor: "transparent", color: "transparent",
            }}>
              {s.v}
            </div>
            <div style={{
              fontSize: 13, fontFamily: F, marginTop: 8,
              color: "rgba(255,255,255,.65)", letterSpacing: "0.02em",
            }}>
              {s.l}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// -- Pricing ------------------------------------------------------------------
function Pricing({ onSignUp }) {
  const free = {
    name: "Free",
    price: "$0",
    period: "forever",
    blurb: "The full analyzer with the essentials. Great for kicking the tires.",
    features: [
      "Full deal analyzer with live data auto-fill",
      "Buy & Hold, BRRRR, and Fix & Flip models",
      "Save up to 5 analyses",
      "Deal feed preview",
    ],
    cta: "Get started",
  };
  const pro = {
    name: "Pro",
    price: "$29.99",
    period: "per month",
    blurb: "Analysis without limits, with live data doing the typing.",
    features: [
      "Everything in Free",
      "Unlimited saved analyses",
      "Full deal feed access",
      "Rental and sale comps for any address",
      "Priority data limits",
      "Cancel anytime",
    ],
    cta: "Start free, upgrade anytime",
    popular: true,
  };

  return (
    <Section id="pricing" tint hexes={HEX_SETS.tint}>
      <SectionHeader
        eyebrow="Pricing"
        title="One simple plan. Cancel anytime."
        subtitle="Try it free. Upgrade when you're ready to see the full feed."
      />
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
        gap: 20, maxWidth: 820, margin: "0 auto",
      }}>
        {[free, pro].map(p => (
          <div key={p.name} style={{
            background: "#fff", borderRadius: 16,
            border: "1px solid " + (p.popular ? C.orange : C.border),
            padding: 28, position: "relative",
            boxShadow: p.popular ? "0 24px 48px -16px rgba(232,115,28,.25)" : "0 1px 2px 0 rgba(15,23,42,.04)",
          }}>
            {p.popular && (
              <div style={{
                position: "absolute", top: -1, right: 20,
                background: C.orange, color: "#fff",
                padding: "5px 12px", borderRadius: "0 0 8px 8px",
                fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
                fontFamily: F,
              }}>
                Most popular
              </div>
            )}
            <div style={{
              fontSize: 13, fontWeight: 600, color: p.popular ? C.orangeDark : C.textSub,
              fontFamily: F, letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 12,
            }}>
              DealHive {p.name}
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
              <span style={{
                fontSize: 44, fontWeight: 700, fontFamily: F, letterSpacing: "-0.035em",
                color: C.text, lineHeight: 1,
              }}>
                {p.price}
              </span>
              <span style={{ fontSize: 14, color: C.textSub, fontFamily: F }}>{p.period}</span>
            </div>
            <p style={{ fontSize: 14, color: C.textSub, fontFamily: F, lineHeight: 1.55, margin: "0 0 20px", minHeight: 44 }}>
              {p.blurb}
            </p>
            <Button onClick={onSignUp} variant={p.popular ? "primary" : "secondary"}
              size="lg" style={{ width: "100%", justifyContent: "center" }}>
              {p.cta}
            </Button>
            <div style={{
              marginTop: 24, paddingTop: 20, borderTop: "1px solid " + C.borderSoft,
              display: "flex", flexDirection: "column", gap: 10,
            }}>
              {p.features.map(f => (
                <div key={f} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13.5, color: C.text, fontFamily: F, lineHeight: 1.45 }}>
                  <span style={{ color: C.orange, flexShrink: 0, marginTop: 1 }}>{I.check}</span>
                  {f}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// -- FAQ ----------------------------------------------------------------------
const FAQ_ITEMS = [
  {
    q: "What is DealHive?",
    a: "DealHive is an investment property analyzer. Enter any U.S. address and it pulls the property details, taxes, home value, and market rent, then runs the numbers as a Buy & Hold, a BRRRR, and a Fix & Flip, cash or financed, and recommends the strategy that wins. There's also a feed of investor-friendly deals when you want inspiration, each pre-scored by the same engine.",
  },
  {
    q: "Where does the property data come from?",
    a: "Public records and live listing data covering 140M+ U.S. properties in all 50 states: beds, baths, square footage, tax bills, assessed values, home value estimates, and market rents. It's built in, so there are no API keys to manage and no tab-hopping between sites.",
  },
  {
    q: "Can I analyze a property I already own?",
    a: "Yes. Flip on \"I Already Own This Property\" and DealHive works from your current loan balance and payment instead of a hypothetical purchase, shows your estimated equity, and models a cash-out refinance or sale against it.",
  },
  {
    q: "How real is the financing math?",
    a: "As real as your deal. Multiple loans on one property, interest-only or amortizing, financing the purchase, the rehab, or both, itemized closing costs that can roll into the loan, and hold periods that actually accrue carrying costs.",
  },
  {
    q: "Can I try it before paying?",
    a: "Yes. The Free plan includes the full analyzer with live data auto-fill and up to 5 saved analyses, no credit card required. When you want unlimited saved analyses and the full deal feed, Pro is $29.99/mo, cancel anytime.",
  },
  {
    q: "Do you guarantee an analysis is right?",
    a: "No tool can guarantee that, and we wouldn't trust one that did. DealHive does the research and the math so you can underwrite faster, but estimates are estimates and you're the one making the buy decision. Always verify numbers, walk the property, and run your own comps.",
  },
  {
    q: "Do I need an MLS license or realtor access?",
    a: "No. DealHive aggregates off-market and publicly available listing data, so you don't need an MLS membership, a license, or any special access to use it.",
  },
  {
    q: "Is my data private?",
    a: "Yes. Your saved deals, notes, and account information are private to your account. We don't sell user data, we don't share watchlists with sellers, and you can delete your account and data anytime.",
  },
];

function FAQ({ items = FAQ_ITEMS.slice(0, 6) }) {
  const [open, setOpen] = useState(0);
  return (
    <Section id="faq" hexes={HEX_SETS.a}>
      <SectionHeader
        eyebrow="FAQ"
        title="Questions, answered."
        center={false}
      />
      <div style={{ display: "grid", gap: 12 }}>
        {items.map((it, i) => {
          const isOpen = open === i;
          return (
            <div key={i} style={{
              border: "1px solid " + C.border, borderRadius: 12, background: "#fff",
              overflow: "hidden",
            }}>
              <button onClick={() => setOpen(isOpen ? -1 : i)}
                style={{
                  width: "100%", padding: "18px 20px", display: "flex", alignItems: "center",
                  justifyContent: "space-between", gap: 16, background: "transparent", border: "none",
                  cursor: "pointer", textAlign: "left", fontFamily: F,
                }}>
                <span style={{ fontSize: 15.5, fontWeight: 600, color: C.text, letterSpacing: "-0.01em" }}>
                  {it.q}
                </span>
                <span style={{ color: C.textMuted, flexShrink: 0 }}>
                  {isOpen ? I.minus : I.plus}
                </span>
              </button>
              {isOpen && (
                <div style={{
                  padding: "0 20px 20px", fontSize: 14.5, color: C.textSub, lineHeight: 1.65,
                  fontFamily: F,
                }}>
                  {it.a}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// -- Final CTA strip ----------------------------------------------------------
function FinalCTA({ onSignUp, title = "Stop guessing at the numbers." }) {
  return (
    <Section dark hexes={HEX_SETS.dark} style={{
      padding: "80px 24px",
      background: `radial-gradient(ellipse at 50% 50%, ${C.navySoft} 0%, ${C.navyDeep} 70%)`,
    }}>
      <div style={{ textAlign: "center", maxWidth: 720, margin: "0 auto" }}>
        <h2 style={{
          fontSize: "clamp(28px, 4.4vw, 44px)", fontWeight: 700, fontFamily: F,
          letterSpacing: "-0.03em", lineHeight: 1.1, margin: "0 0 16px", color: "#fff",
        }}>
          {title}
        </h2>
        <p style={{
          fontSize: "clamp(15px, 1.8vw, 18px)", color: "rgba(255,255,255,.7)",
          fontFamily: F, margin: "0 0 32px", lineHeight: 1.55,
        }}>
          Run any address through a real underwriting engine before you write the offer. Get started for free with no card and no commitment.
        </p>
        <Button onClick={onSignUp} size="lg" style={{ padding: "16px 28px", fontSize: 16 }}>
          Get started free {I.arrow}
        </Button>
      </div>
    </Section>
  );
}

// -- Footer -------------------------------------------------------------------
function Footer({ navigate, onSignIn, onSignUp }) {
  const year = new Date().getFullYear();
  const link = (label, path) => (
    <a key={label} href={path} onClick={e => { e.preventDefault(); navigate(path); }}
      style={{
        fontSize: 13.5, color: C.textSub, fontFamily: F, textDecoration: "none",
        cursor: "pointer",
      }}>
      {label}
    </a>
  );
  return (
    <footer style={{
      padding: "48px 24px 32px", background: "#fff", borderTop: "1px solid " + C.border,
      fontFamily: F,
    }}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <div style={{
          display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr", gap: 32, marginBottom: 40,
        }} className="dh-footer-grid">
          <div>
            <img src="/logo.png" alt="DealHive" style={{ height: 36, width: "auto", marginBottom: 14 }}/>
            <p style={{ fontSize: 13, color: C.textSub, lineHeight: 1.55, margin: 0, maxWidth: 320 }}>
              The investment property analyzer that does the research for you. Any address, any strategy, in seconds.
            </p>
          </div>
          <FooterCol title="Platform">
            {link("Features", "/features")}
            {link("Pricing", "/pricing")}
            {link("FAQ", "/faq")}
          </FooterCol>
          <FooterCol title="Use Cases">
            {link("Rental Property Analysis", "/use-cases/rental-property-analysis")}
            {link("BRRRR Analysis", "/use-cases/brrrr-analysis")}
            {link("Fix & Flip Analysis", "/use-cases/fix-and-flip-analysis")}
          </FooterCol>
          <FooterCol title="Company">
            {link("About", "/about")}
            {link("Contact", "/contact")}
            <button onClick={onSignIn} style={footerBtnStyle}>Sign in</button>
            <button onClick={onSignUp} style={footerBtnStyle}>Get started</button>
          </FooterCol>
        </div>
        <div style={{
          paddingTop: 24, borderTop: "1px solid " + C.border,
          display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap",
        }}>
          <div style={{ fontSize: 12, color: C.textMuted, fontFamily: F }}>
            © {year} DealHive. All rights reserved.
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
            <a href="/privacy" onClick={e => { e.preventDefault(); navigate("/privacy"); }}
              style={{ fontSize: 12, color: C.textMuted, fontFamily: F, textDecoration: "none" }}>
              Privacy Policy
            </a>
            <a href="/terms" onClick={e => { e.preventDefault(); navigate("/terms"); }}
              style={{ fontSize: 12, color: C.textMuted, fontFamily: F, textDecoration: "none" }}>
              Terms of Use
            </a>
          </div>
        </div>
      </div>
      <style>{`
        @media (max-width: 760px) {
          .dh-footer-grid { grid-template-columns: 1fr 1fr !important; gap: 28px !important; }
          .dh-footer-grid > div:first-child { grid-column: 1 / -1; }
        }
      `}</style>
    </footer>
  );
}

const footerBtnStyle = {
  background: "transparent", border: "none", padding: 0, cursor: "pointer",
  textAlign: "left", fontSize: 13.5, color: C.textSub, fontFamily: F,
};

function FooterCol({ title, children }) {
  return (
    <div>
      <div style={{
        fontSize: 12, fontWeight: 700, color: C.text, letterSpacing: "0.06em",
        textTransform: "uppercase", marginBottom: 14, fontFamily: F,
      }}>
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {children}
      </div>
    </div>
  );
}

// ==============================================================================
// PAGES
// ==============================================================================

function HomePage({ onSignUp }) {
  return (
    <>
      <Hero onSignUp={onSignUp}/>
      <TrustBar/>
      <HowItWorks/>
      <Features/>
      <NumbersStrip/>
      <Pricing onSignUp={onSignUp}/>
      <FAQ/>
      <FinalCTA onSignUp={onSignUp}/>
    </>
  );
}

// -- Features page: overview grid + one section per strategy -------------------
const STRATEGIES = [
  {
    id: "rental",
    eyebrow: "Buy & hold",
    title: "Rental property analysis, done before you open the deal.",
    body: "Every deal in the feed is scored as a rental first: cap rate, monthly cash flow, cash-on-cash return, and operating expenses estimated from real tax rates for that state, not national averages. If a property doesn't pencil as a rental or a flip, it never reaches your feed.",
    points: [
      "Cap rate and cash flow computed on arrival",
      "State-accurate property tax rates",
      "Vacancy, insurance, and maintenance baked into the pro forma",
      "Adjust any number in the analyzer and watch it recalculate",
    ],
  },
  {
    id: "brrrr",
    eyebrow: "BRRRR",
    title: "See the refinance math before you buy.",
    body: "For value-add deals, DealHive projects the BRRRR path: purchase, rehab budget, after-repair value, and what your capital position looks like after the refi. Know how much of your money comes back out before you commit it.",
    points: [
      "ARV estimates on deals with rehab potential",
      "Rehab budgets estimated from light / medium / full renovation rates",
      "Post-refi equity and cash-left-in-deal projections",
      "Compare BRRRR vs straight rental on the same property",
    ],
  },
  {
    id: "flip",
    eyebrow: "Fix & flip",
    title: "Flip numbers that include the costs everyone forgets.",
    body: "Flip scoring accounts for purchase, rehab, holding costs, and selling costs, then shows projected profit and ROI. Deals only earn the flip tag when the ROI clears a real threshold, so a \"flip deal\" in DealHive actually means something.",
    points: [
      "Projected profit and ROI on every flip-tagged deal",
      "Holding and selling costs included, not ignored",
      "ARV backed by comparable sales",
      "Side-by-side with the rental math on the same deal",
    ],
  },
  {
    id: "feed",
    eyebrow: "The deal feed",
    title: "Off-market deal flow without the 6am scroll.",
    body: "Wholesale assignment lists, off-market properties, and investor-friendly listings from markets across the country land in one feed, refreshed every day. Filter by market, price, and strategy. Save what you like, and it's waiting on your dashboard.",
    points: [
      "Hundreds of properties scanned daily",
      "Deals tagged buy-and-hold, flip, or both",
      "Market and price filters that reflect what's actually live",
      "One-tap save to your watchlist",
    ],
  },
];

// "Screenshot" panels: hand-built mock UI in the app's exact visual language,
// framed in a window chrome. Crisper than PNGs and always on-brand; swap for
// real captures anytime.
function AppFrame({ label, children }) {
  return (
    <div style={{
      borderRadius: 18, border: "1px solid " + C.border, background: "#fff",
      boxShadow: "0 28px 56px -20px rgba(15,23,42,.22), 0 8px 20px -12px rgba(15,23,42,.10)",
      overflow: "hidden",
    }}>
      <div style={{display:"flex", alignItems:"center", gap:6, padding:"10px 14px",
        background:C.bgSoft, borderBottom:"1px solid "+C.border}}>
        {["#fca5a5","#fcd34d","#86efac"].map(c => (
          <span key={c} style={{width:9, height:9, borderRadius:"50%", background:c, display:"inline-block"}}/>
        ))}
        <span style={{marginLeft:8, fontSize:11.5, fontWeight:600, color:C.textSub, fontFamily:F}}>{label}</span>
      </div>
      <div style={{padding:16}}>{children}</div>
    </div>
  );
}
const MockHeader = ({ color, label }) => (
  <div style={{display:"flex", alignItems:"center", gap:9, padding:"9px 12px", marginBottom:10,
    background:`${color}12`, borderLeft:"3px solid "+color, borderRadius:8}}>
    <span style={{width:22, height:22, borderRadius:6, background:`${color}22`, color,
      display:"inline-flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:800, fontFamily:F}}>
      ▮
    </span>
    <span style={{fontSize:13.5, fontWeight:700, color:C.text, fontFamily:F, letterSpacing:"-0.01em"}}>{label}</span>
  </div>
);
const MockRow = ({ l, v, color = C.text, hr }) => hr ? (
  <div style={{height:1, background:C.border, margin:"7px 0"}}/>
) : (
  <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:10,
    padding:"6.5px 2px", borderBottom:"1px solid "+C.borderSoft, fontFamily:F}}>
    <span style={{fontSize:12.5, color:C.textSub}}>{l}</span>
    <span style={{fontSize:13.5, fontWeight:700, color, fontVariantNumeric:"tabular-nums", letterSpacing:"-0.01em"}}>{v}</span>
  </div>
);
const MockBadge = ({ children, bg = C.cashPos }) => (
  <span style={{display:"inline-flex", alignItems:"center", gap:5, background:bg, color:"#fff",
    padding:"3px 10px", borderRadius:9999, fontSize:10.5, fontWeight:800, fontFamily:F,
    letterSpacing:".04em", textTransform:"uppercase"}}>{children}</span>
);

function StrategyMock({ id }) {
  if (id === "rental") return (
    <AppFrame label="DealHive · Deal Analyzer">
      <MockHeader color="#059669" label="Summary"/>
      <MockRow l="Purchase Method" v="Cash"/>
      <MockRow l="Exit Strategy" v="Buy & Hold"/>
      <MockRow l="Out of Pocket" v="$96,500"/>
      <MockRow l="Net Cash Flow / mo" v="$612" color={C.cashPos}/>
      <MockRow l="Cash-on-Cash" v="7.6%" color={C.cashPos}/>
      <MockRow l="Cap Rate" v="9.1%"/>
      <div style={{marginTop:12}}><MockBadge>Recommended · Buy & Hold</MockBadge></div>
    </AppFrame>
  );
  if (id === "brrrr") return (
    <AppFrame label="DealHive · Deal Analyzer">
      <MockHeader color="#7c3aed" label="BRRRR Estimate"/>
      <MockRow l="Cash Out Amount" v="$113,600"/>
      <MockRow l="Refi Interest Rate" v="7.5%"/>
      <MockRow hr/>
      <MockRow l="Cash Received at Refi" v="$113,600" color={C.cashPos}/>
      <MockRow l="Cash Flow / mo (After Refi)" v="$241" color={C.cashPos}/>
      <MockRow l="Cash in Pocket" v="$9,450" color={C.cashPos}/>
      <div style={{marginTop:12}}><MockBadge bg="#7c3aed">Best Exit · BRRRR</MockBadge></div>
    </AppFrame>
  );
  if (id === "flip") return (
    <AppFrame label="DealHive · Deal Analyzer">
      <MockHeader color="#d97706" label="Fix & Flip"/>
      <MockRow l="Sale Price (ARV)" v="$189,000"/>
      <MockRow l="Holding Costs (6 mo)" v="$4,320"/>
      <MockRow l="Loan Payoff at Sale" v="$98,400"/>
      <MockRow hr/>
      <MockRow l="Total Cash In" v="$31,600"/>
      <MockRow l="Net Profit" v="$42,830" color={C.cashPos}/>
      <MockRow l="ROI on Cash" v="135.5%" color={C.cashPos}/>
      <div style={{marginTop:12}}><MockBadge bg="#d97706">Best Exit · Fix & Flip</MockBadge></div>
    </AppFrame>
  );
  return (
    <MockDealCard
      photo={["#fef3c7", "#fde68a"]}
      imgUrl="https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=720&h=400&q=80"
      address="Cleveland, OH 44109"
      price={84500} rent={1450} capRate={14.2} cashflow={612}
      beds={3} baths={1} sqft={1240}
      badge="Buy & Hold"
    />
  );
}

function FeaturesPage({ onSignUp }) {
  return (
    <>
      <PageHero
        eyebrow="Features"
        title="Built to find deals, not manage spreadsheets."
        subtitle="Everything DealHive does exists to answer one question fast: is this property worth your money?"
      />
      <Features eyebrow={null}/>
      {STRATEGIES.map((s, i) => (
        <Section key={s.id} style={{ background: i % 2 ? C.bgSoft : C.bg, padding: "64px 24px" }} hexes={i % 2 ? HEX_SETS.a : HEX_SETS.b}>
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: 56, alignItems: "center",
          }} className="dh-strat-grid">
            <div style={{ order: i % 2 ? 2 : 1 }}>
              <div style={{ marginBottom: 14 }}><Eyebrow>{s.eyebrow}</Eyebrow></div>
              <h2 style={{
                fontSize: "clamp(24px, 3.2vw, 34px)", fontWeight: 700, fontFamily: F,
                letterSpacing: "-0.025em", lineHeight: 1.15, margin: "0 0 14px", color: C.text,
              }}>
                {s.title}
              </h2>
              <p style={{ fontSize: 15.5, color: C.textSub, fontFamily: F, lineHeight: 1.65, margin: 0 }}>
                {s.body}
              </p>
              <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 10 }}>
                {s.points.map(p => (
                  <div key={p} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontFamily: F }}>
                    <span style={{
                      width: 19, height: 19, borderRadius: 9999, background: C.orangeSubtle,
                      border: "1px solid " + C.orangeBorder, color: C.orangeDark, flexShrink: 0,
                      display: "inline-flex", alignItems: "center", justifyContent: "center", marginTop: 1,
                    }}>
                      <Icon d={<path d="M5 12l5 5L20 7"/>} size={11} stroke={2.6}/>
                    </span>
                    <span style={{ fontSize: 14, color: C.text, lineHeight: 1.5 }}>{p}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ order: i % 2 ? 1 : 2, position: "relative" }}>
              <div aria-hidden="true" style={{
                position: "absolute", inset: -30,
                background: `radial-gradient(closest-side, ${C.orangeSubtle}, transparent 72%)`,
                filter: "blur(18px)", zIndex: 0,
              }}/>
              <div style={{ position: "relative", zIndex: 1,
                transform: `perspective(1200px) rotateY(${i % 2 ? "5deg" : "-5deg"})` }}>
                <StrategyMock id={s.id}/>
              </div>
            </div>
          </div>
          <style>{`
            @media (max-width: 860px) {
              .dh-strat-grid { grid-template-columns: 1fr !important; gap: 28px !important; }
              .dh-strat-grid > div { order: unset !important; }
            }
          `}</style>
        </Section>
      ))}
      <NumbersStrip/>
      <FinalCTA onSignUp={onSignUp} title="See the feed for yourself."/>
    </>
  );
}

function PricingPage({ onSignUp }) {
  const pricingFaq = [
    {
      q: "Can I cancel anytime?",
      a: "Yes. Cancel from Settings in two clicks and you keep Pro access until the end of your billing period. No calls, no emails, no retention flows.",
    },
    {
      q: "What happens to my saved deals if I downgrade?",
      a: "They stay saved. You keep your watchlist and all your analyses on the Free plan. You just see the preview feed instead of the full one.",
    },
    {
      q: "Is there a contract or setup fee?",
      a: "No. Pro is month-to-month, $29.99, and the price you sign up at is the price you keep.",
    },
    {
      q: "Do you offer refunds?",
      a: "If something went wrong on our end, contact support@dealhive.io and we'll make it right.",
    },
  ];
  return (
    <>
      <PageHero
        eyebrow="Pricing"
        title="Less than one bad showing costs you."
        subtitle="Start free, no credit card. Upgrade when you want the full feed. Cancel anytime."
      />
      <Pricing onSignUp={onSignUp}/>
      <FAQ items={pricingFaq}/>
      <FinalCTA onSignUp={onSignUp} title="Your next deal might already be in the feed."/>
    </>
  );
}

function FAQPage({ onSignUp }) {
  return (
    <>
      <PageHero
        eyebrow="FAQ"
        title="Everything people ask us."
        subtitle="Can't find your answer? Email support@dealhive.io and a human will read it."
      />
      <FAQ items={FAQ_ITEMS}/>
      <FinalCTA onSignUp={onSignUp}/>
    </>
  );
}

function AboutPage({ onSignUp }) {
  const beliefs = [
    {
      title: "The deal is everything",
      body: "Returns are made at the buy. Software should make finding the right buy faster, not bury you in dashboards.",
    },
    {
      title: "Numbers before feelings",
      body: "Every property in DealHive is scored against real pro formas before you ever see it. If it doesn't pencil, it doesn't ship.",
    },
    {
      title: "Investors deserve tools that respect their time",
      body: "No 45-minute demos, no sales calls, no annual contracts. Open the app, see the deals, make a decision.",
    },
  ];
  return (
    <>
      <PageHero
        eyebrow="About"
        title="Built by investors who got tired of scrolling."
        subtitle="DealHive exists because finding a deal shouldn't take longer than analyzing one."
      />
      <Section style={{ padding: "24px 24px 64px" }} hexes={HEX_SETS.b}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          <p style={{ fontSize: 17, color: C.textSub, fontFamily: F, lineHeight: 1.75 }}>
            Every real estate investor knows the routine: a promising address, six open tabs, a
            spreadsheet from 2019, and an hour of copying numbers between them just to find out
            the deal never penciled in the first place. The math was never the hard part. The
            gathering was.
          </p>
          <p style={{ fontSize: 17, color: C.textSub, fontFamily: F, lineHeight: 1.75 }}>
            DealHive collapses that routine into seconds. Type an address and the property data
            fills itself in from live records. The engine runs Buy & Hold, BRRRR, and Fix & Flip,
            cash or financed, and tells you which exit wins. When you want inspiration, a feed of
            pre-scored deals is a tap away. But the analyzer is the product: your underwriting,
            faster and sharper.
          </p>
          <p style={{ fontSize: 17, color: C.textSub, fontFamily: F, lineHeight: 1.75 }}>
            We're independent, investor-run, and built for people who close. No venture pressure to
            juice engagement metrics, just a tool we wanted for ourselves, opened up to everyone.
          </p>
        </div>
      </Section>
      <Section style={{ background: C.bgSoft }} hexes={HEX_SETS.a}>
        <SectionHeader eyebrow="What we believe" title="Three things we won't compromise on."/>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20 }}>
          {beliefs.map(b => (
            <div key={b.title} style={{
              padding: 26, background: "#fff", border: "1px solid " + C.border, borderRadius: 14,
            }}>
              <h3 style={{ fontSize: 16.5, fontWeight: 700, fontFamily: F, letterSpacing: "-0.015em", margin: "0 0 8px", color: C.text }}>
                {b.title}
              </h3>
              <p style={{ fontSize: 14.5, color: C.textSub, fontFamily: F, lineHeight: 1.6, margin: 0 }}>
                {b.body}
              </p>
            </div>
          ))}
        </div>
      </Section>
      <FinalCTA onSignUp={onSignUp} title="See what the feed found today."/>
    </>
  );
}

// -- Use-case pages (linked from the footer only) --------------------------------
const USE_CASES = {
  "/use-cases/rental-property-analysis": {
    mock: "rental", eyebrow: "Rental Property Analysis",
    title: "Underwrite rentals like you've done a hundred of them.",
    sub: "Cash flow, cap rate, cash-on-cash, and operating expenses computed the moment you enter an address.",
    intro: "A rental lives or dies on the numbers: what it really rents for, what it really costs to hold, and what's left after the mortgage. DealHive pulls the property's tax bill and market rent from live records, models your exact financing, and shows the monthly cash flow before you've finished your coffee.",
    rows: [
      ["Live rent estimates", "Market rent with a range, plus nearby active rentals to sanity-check it against, right inside the analyzer."],
      ["State-accurate taxes", "Property tax auto-fills from real records or your state's effective rate, not a national average."],
      ["Real financing", "Down payment or full loan modeling, interest-only or amortizing, and vacancy baked into effective rent."],
      ["The verdict", "Net cash flow, cap rate, and cash-on-cash side by side, with a clear recommendation against BRRRR and flip exits."],
    ],
  },
  "/use-cases/brrrr-analysis": {
    mock: "brrrr", eyebrow: "BRRRR Analysis",
    title: "Model the whole BRRRR before you buy the drill.",
    sub: "Buy, rehab, rent, refinance: sized against your ARV with the refi math investors actually use.",
    intro: "The BRRRR question is simple: how much of my money comes back at the refinance, and does the property still cash flow on the new loan? DealHive sizes the cash-out at your ARV, nets it against any loans it has to pay off, and shows the cash that actually lands in your pocket.",
    rows: [
      ["Cash-out sized from ARV", "The refinance pre-fills at 80% of your after-repair value, with your own refi rate and term."],
      ["Loan payoffs handled", "Financed purchases net the refi against existing loans, so Net Cash at Refi is the real number."],
      ["Post-refi cash flow", "Rent minus expenses minus the new payment, so you know the hold still works after the cash-out."],
      ["Cash in Pocket", "The headline BRRRR number: what the refinance returns beyond your total investment."],
    ],
  },
  "/use-cases/fix-and-flip-analysis": {
    mock: "flip", eyebrow: "Fix & Flip Analysis",
    title: "Know your flip profit before the first demo day.",
    sub: "ARV, rehab, holding costs, loan payoff, and ROI on your actual cash, not the purchase price.",
    intro: "Flips fail in the carrying costs and the payoff line, not the paint budget. DealHive accrues holding costs over your real timeline, includes the debt service when you're financed, pays off the loan at sale, and measures ROI against the cash you actually put in — the number that makes leveraged flips make sense.",
    rows: [
      ["Hold period that costs money", "Set the months to rehab and sell; taxes, insurance, and loan payments accrue for every one of them."],
      ["Itemized rehab budgets", "Break repairs into line items, roll costs into the loan, drag to reorder, and the totals follow."],
      ["Hard-money friendly", "Interest-only loans, rehab financing, and points rolled into the balance, modeled like the real thing."],
      ["ROI on cash", "Profit measured against your cash in the deal. Leverage shows up honestly, both directions."],
    ],
  },
};

function UseCasePage({ path, onSignUp }) {
  const uc = USE_CASES[path];
  if (!uc) return null;
  return (
    <>
      <PageHero eyebrow={uc.eyebrow} title={uc.title} subtitle={uc.sub}/>
      <Section style={{ padding: "16px 24px 72px" }}>
        <div style={{
          display: "grid", gridTemplateColumns: "1.05fr 1fr", gap: 56, alignItems: "center",
        }} className="dh-strat-grid">
          <div>
            <p style={{ fontSize: 16, color: C.textSub, fontFamily: F, lineHeight: 1.7, marginTop: 0 }}>
              {uc.intro}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 22 }}>
              {uc.rows.map(([t, b]) => (
                <div key={t} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <span style={{
                    width: 22, height: 22, borderRadius: 9999, background: C.orangeSubtle,
                    border: "1px solid " + C.orangeBorder, color: C.orangeDark, flexShrink: 0,
                    display: "inline-flex", alignItems: "center", justifyContent: "center", marginTop: 2,
                  }}>
                    <Icon d={<path d="M5 12l5 5L20 7"/>} size={12} stroke={2.6}/>
                  </span>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: C.text, fontFamily: F, letterSpacing: "-0.01em" }}>{t}</div>
                    <div style={{ fontSize: 13.5, color: C.textSub, fontFamily: F, lineHeight: 1.55, marginTop: 2 }}>{b}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ position: "relative" }}>
            <div aria-hidden="true" style={{
              position: "absolute", inset: -30,
              background: `radial-gradient(closest-side, ${C.orangeSubtle}, transparent 72%)`,
              filter: "blur(18px)", zIndex: 0,
            }}/>
            <div style={{ position: "relative", zIndex: 1, transform: "perspective(1200px) rotateY(-5deg)" }}>
              <StrategyMock id={uc.mock}/>
            </div>
          </div>
        </div>
      </Section>
      <NumbersStrip/>
      <FinalCTA onSignUp={onSignUp} title="Run your next one through DealHive."/>
    </>
  );
}

function ContactPage() {
  return (
    <>
      <PageHero
        eyebrow="Contact"
        title="Talk to a human."
        subtitle="Questions, feedback, billing, partnership ideas. One inbox, real replies."
      />
      <Section style={{ padding: "24px 24px 96px" }} hexes={HEX_SETS.a}>
        <div style={{
          maxWidth: 560, margin: "0 auto", background: "#fff",
          border: "1px solid " + C.border, borderRadius: 16, padding: 32,
          textAlign: "center", boxShadow: "0 12px 32px -12px rgba(15,23,42,.08)",
        }}>
          <div style={{
            width: 52, height: 52, borderRadius: 14, margin: "0 auto 16px",
            background: C.orangeSubtle, border: "1px solid " + C.orangeBorder, color: C.orangeDark,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {I.mail}
          </div>
          <h2 style={{ fontSize: 22, fontWeight: 700, fontFamily: F, letterSpacing: "-0.02em", margin: "0 0 8px", color: C.text }}>
            support@dealhive.io
          </h2>
          <p style={{ fontSize: 14.5, color: C.textSub, fontFamily: F, lineHeight: 1.6, margin: "0 0 24px" }}>
            We typically reply within one business day. Include your account email if it's about billing or your data.
          </p>
          <Button onClick={() => window.location.assign("mailto:support@dealhive.io")} size="lg">
            {I.mail} Email us
          </Button>
        </div>
      </Section>
    </>
  );
}

// -- Legal pages ---------------------------------------------------------------
function LegalPage({ title, updated, children }) {
  return (
    <>
      <PageHero title={title} subtitle={"Last updated: " + updated}/>
      <Section style={{ padding: "8px 24px 96px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", fontFamily: F }} className="dh-legal">
          {children}
        </div>
        <style>{`
          .dh-legal h2 { font-size: 19px; font-weight: 700; color: ${C.text}; letter-spacing: -0.015em; margin: 36px 0 10px; }
          .dh-legal p, .dh-legal li { font-size: 14.5px; color: ${C.textSub}; line-height: 1.7; }
          .dh-legal ul { padding-left: 22px; margin: 10px 0; }
          .dh-legal strong { color: ${C.text}; }
          .dh-legal a { color: ${C.orangeDark}; }
        `}</style>
      </Section>
    </>
  );
}

function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="July 7, 2026">
      <p>
        This Privacy Policy explains how DealHive ("DealHive", "we", "us") collects, uses, and
        protects your information when you use the DealHive website and applications (the
        "Service"). By using the Service you agree to this policy.
      </p>

      <h2>1. Information we collect</h2>
      <ul>
        <li><strong>Account information.</strong> Your email address and a password (stored in hashed form by our authentication provider, so we never see or store your plain-text password).</li>
        <li><strong>Content you create.</strong> Deals you save, analyses you run, settings you configure, and notes you enter. This data exists so the app can work for you and is private to your account.</li>
        <li><strong>Payment information.</strong> Payments are processed by Stripe. Your card number goes directly to Stripe and never touches our servers. We store only your subscription status and Stripe customer reference.</li>
        <li><strong>Usage and device data.</strong> Basic technical logs (browser type, approximate region, error reports) used to keep the Service reliable and secure.</li>
      </ul>

      <h2>2. How we use your information</h2>
      <ul>
        <li>To provide and improve the Service: syncing your data across devices, showing your saved deals, operating the deal feed.</li>
        <li>To process subscriptions and send transactional emails (receipts, password resets, important account notices).</li>
        <li>To protect the Service against abuse, fraud, and security issues.</li>
      </ul>
      <p>
        We do <strong>not</strong> sell your personal information. We do not share your watchlist,
        saved deals, or analyses with sellers, wholesalers, or other users. We do not run
        third-party advertising on the Service.
      </p>

      <h2>3. Service providers</h2>
      <p>We rely on a small set of processors to run the Service:</p>
      <ul>
        <li><strong>Google Firebase</strong>: authentication and database hosting for your account data.</li>
        <li><strong>Stripe</strong>: payment processing and subscription billing.</li>
        <li><strong>Netlify</strong>: website hosting.</li>
        <li><strong>Google Maps Platform</strong>: property imagery and address lookup.</li>
      </ul>
      <p>Each provider processes data only as needed to provide their service to us.</p>

      <h2>4. Property data</h2>
      <p>
        The deals and property information shown in the Service are aggregated from third-party and
        public sources and relate to real estate, not to you personally. Your interaction with that
        data (what you view, save, or analyze) stays private to your account.
      </p>

      <h2>5. Data retention & deletion</h2>
      <p>
        We keep your account data for as long as your account exists. You can delete your account
        and all associated data at any time by emailing{" "}
        <a href="mailto:support@dealhive.io">support@dealhive.io</a> from your account email.
        Deletion is completed within 30 days. You can also request an export of your data.
      </p>

      <h2>6. Security</h2>
      <p>
        Your data is transmitted over HTTPS and stored with per-user access rules, so one account
        can never read another's data. No system is perfectly secure, but we design so that the
        blast radius of any failure is as small as possible.
      </p>

      <h2>7. Children</h2>
      <p>The Service is intended for users 18 and older and is not directed at children.</p>

      <h2>8. Changes to this policy</h2>
      <p>
        If we make material changes we will update the date above and, for significant changes,
        notify you in the app or by email.
      </p>

      <h2>9. Contact</h2>
      <p>
        Questions about privacy or your data:{" "}
        <a href="mailto:support@dealhive.io">support@dealhive.io</a>
      </p>
    </LegalPage>
  );
}

function TermsPage() {
  return (
    <LegalPage title="Terms of Use" updated="July 7, 2026">
      <p>
        These Terms of Use ("Terms") govern your access to and use of the DealHive website and
        applications (the "Service"), operated by DealHive ("we", "us"). By creating an account or
        using the Service, you agree to these Terms and to our{" "}
        <a href="/privacy">Privacy Policy</a>.
      </p>

      <h2>1. The Service</h2>
      <p>
        DealHive aggregates real estate deal information from third-party and public sources and
        provides analysis tools for evaluating potential investments. The Service is an
        informational tool. It is not a brokerage, lender, appraiser, or investment advisor.
      </p>

      <h2>2. Accounts</h2>
      <p>
        You must provide accurate information when creating an account and keep your credentials
        secure. You are responsible for activity under your account. One account per person; you
        may not share, sell, or transfer your account.
      </p>

      <h2>3. Subscriptions & billing</h2>
      <ul>
        <li>The Free plan is free indefinitely and includes the features described on our Pricing page.</li>
        <li>DealHive Pro is a monthly subscription billed through Stripe at the price shown at checkout. It renews automatically each month until cancelled.</li>
        <li>You can cancel anytime; access continues through the end of the paid period. Fees already paid are non-refundable except where required by law or where we determine an error on our part.</li>
        <li>We may change subscription pricing with at least 30 days' notice; existing subscribers keep their sign-up price unless notified otherwise.</li>
      </ul>

      <h2>4. License & acceptable use</h2>
      <p>
        We grant you a limited, non-exclusive, non-transferable license to use the Service for your
        own real estate investing activities. You agree not to:
      </p>
      <ul>
        <li>Scrape, harvest, resell, or redistribute the Service's data or content;</li>
        <li>Reverse engineer, copy, or create derivative works of the Service;</li>
        <li>Use the Service to violate any law or third-party right;</li>
        <li>Interfere with or disrupt the Service, or attempt to access other users' data.</li>
      </ul>

      <h2>5. Property data & reports disclaimer</h2>
      <p>
        <strong>Read this section carefully.</strong> Property information, deal listings,
        estimates, analyses, and reports in the Service are generated from data provided by third
        parties and public records. We do not independently verify this data, and it may be
        incomplete, outdated, or inaccurate. Analyses and projections are mathematical models based
        on assumptions. They are <strong>not</strong> certified appraisals, broker price opinions,
        or investment, legal, tax, or financial advice.
      </p>
      <p>
        Real estate investing involves substantial risk, including loss of capital. You are solely
        responsible for your investment decisions. Always independently verify property details,
        condition, title, rents, and values, and consult licensed professionals, before
        purchasing any property.
      </p>

      <h2>6. Intellectual property</h2>
      <p>
        The Service, including its software, design, and branding, is owned by us or our licensors
        and protected by intellectual property laws. These Terms grant you no ownership rights.
        Content you create in your account (notes, saved analyses) remains yours.
      </p>

      <h2>7. Third-party content & services</h2>
      <p>
        The Service links to and displays content from third parties (listings, maps, imagery). We
        are not responsible for third-party content or services, and your use of them may be
        subject to their own terms.
      </p>

      <h2>8. Termination</h2>
      <p>
        You may stop using the Service or delete your account at any time. We may suspend or
        terminate accounts that violate these Terms or that create risk for the Service or other
        users. Upon termination, sections 5–11 survive.
      </p>

      <h2>9. Disclaimer of warranties</h2>
      <p>
        THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS
        OR IMPLIED, INCLUDING FITNESS FOR A PARTICULAR PURPOSE, ACCURACY, AND NON-INFRINGEMENT. WE
        DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR THAT ANY DEAL WILL BE
        AVAILABLE, ACCURATE, OR PROFITABLE.
      </p>

      <h2>10. Limitation of liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
        SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, LOST DATA, OR INVESTMENT
        LOSSES, ARISING FROM YOUR USE OF THE SERVICE. OUR TOTAL LIABILITY FOR ANY CLAIM IS LIMITED
        TO THE AMOUNT YOU PAID US IN THE TWELVE MONTHS BEFORE THE CLAIM AROSE (OR $50 IF YOU PAID
        NOTHING).
      </p>

      <h2>11. Indemnification</h2>
      <p>
        You agree to indemnify and hold us harmless from claims arising out of your use of the
        Service, your investment decisions, or your violation of these Terms.
      </p>

      <h2>12. Changes to these Terms</h2>
      <p>
        We may update these Terms from time to time. We'll update the date above and, for material
        changes, notify you in the app or by email. Continued use after changes take effect means
        you accept the updated Terms.
      </p>

      <h2>13. Governing law</h2>
      <p>
        These Terms are governed by the laws of the United States and the state in which DealHive's
        operating company is organized, without regard to conflict-of-law rules. Disputes will be
        resolved in the courts of that state.
      </p>

      <h2>14. Contact</h2>
      <p>
        Questions about these Terms:{" "}
        <a href="mailto:support@dealhive.io">support@dealhive.io</a>
      </p>
    </LegalPage>
  );
}

// Marketing chrome (nav + footer) as a wrapper, so the auth pages in App.jsx
// can live inside the same shell as the rest of the site.
export function MarketingChrome({ navigate, onSignIn, onSignUp, children }) {
  return (
    <div style={{ background: C.bg, color: C.text, minHeight: "100vh" }}>
      <TopNav navigate={navigate} onSignIn={onSignIn} onSignUp={onSignUp}/>
      {children}
      <Footer navigate={navigate} onSignIn={onSignIn} onSignUp={onSignUp}/>
    </div>
  );
}

// ==============================================================================
// Top-level export — routes to the right page
// ==============================================================================
const PAGE_TITLES = {
  "/":          "DealHive: Analyze Any Investment Property in Seconds",
  "/features":  "DealHive Features",
  "/pricing":   "DealHive Pricing",
  "/faq":       "DealHive FAQ",
  "/about":     "About DealHive",
  "/contact":   "Contact DealHive",
  "/use-cases/rental-property-analysis": "Rental Property Analysis | DealHive",
  "/use-cases/brrrr-analysis":           "BRRRR Analysis | DealHive",
  "/use-cases/fix-and-flip-analysis":    "Fix & Flip Analysis | DealHive",
  "/privacy":   "DealHive Privacy Policy",
  "/terms":     "DealHive Terms of Use",
};

export default function Landing({ page = "/", navigate, onSignIn, onSignUp }) {
  useEffect(() => {
    window.scrollTo(0, 0);
    document.title = PAGE_TITLES[page] || PAGE_TITLES["/"];
  }, [page]);

  const body =
    page === "/features" ? <FeaturesPage onSignUp={onSignUp}/> :
    page === "/pricing"  ? <PricingPage onSignUp={onSignUp}/> :
    page === "/faq"      ? <FAQPage onSignUp={onSignUp}/> :
    page === "/about"    ? <AboutPage onSignUp={onSignUp}/> :
    page === "/contact"  ? <ContactPage/> :
    page.startsWith("/use-cases/") && USE_CASES[page] ? <UseCasePage path={page} onSignUp={onSignUp}/> :
    page === "/privacy"  ? <PrivacyPage/> :
    page === "/terms"    ? <TermsPage/> :
    <HomePage onSignUp={onSignUp}/>;

  return (
    <div style={{ background: C.bg, color: C.text, minHeight: "100vh" }}>
      <style>{`
        @keyframes dhFloat1 { from { transform: translateY(0); }    to { transform: translateY(-14px); } }
        @keyframes dhFloat2 { from { transform: translateY(-8px); } to { transform: translateY(10px); } }
        @keyframes dhFloat3 { from { transform: translateY(6px); }  to { transform: translateY(-10px); } }
        @media (prefers-reduced-motion: reduce) {
          .dh-hero svg { animation: none !important; }
        }
        @media (max-width: 640px) {
          .dh-section { padding: 52px 20px !important; }
          .dh-hero { padding: 48px 20px 64px !important; }
          .dh-page-hero { padding: 44px 20px 36px !important; }
          .dh-sec-head { margin-bottom: 32px !important; }
          .dh-hero-ctas { flex-direction: column; }
          .dh-hero-ctas > button { width: 100%; justify-content: center; }
          .dh-check-divider { display: none !important; }
          .dh-hero-checks { justify-content: center; }
          .dh-numbers { grid-template-columns: repeat(2, 1fr) !important; gap: 26px !important; }
          .dh-hv-tilt { transform: perspective(1200px) rotateY(-4deg) rotateX(2deg); }
          .dh-hv-b { transform: translateX(18px) !important; }
          .dh-hv-c { transform: translateX(-12px) !important; }
        }
      `}</style>
      <TopNav navigate={navigate} onSignIn={onSignIn} onSignUp={onSignUp}/>
      {body}
      <Footer navigate={navigate} onSignIn={onSignIn} onSignUp={onSignUp}/>
    </div>
  );
}
