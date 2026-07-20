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

function Eyebrow({ children, tone }) {
  const a = tone?.a, d = tone?.d;
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 8,
      padding: "6px 12px", borderRadius: 9999,
      background: a ? `${a}12` : C.orangeSubtle,
      border: "1px solid " + (a ? `${a}55` : C.orangeBorder),
      color: d || C.orangeDark,
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
            imgUrl="/flip-house.jpeg"
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
              background:"#fff", padding:"14px 24px"}}>
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
              padding: "8px 24px 24px",
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
  const [yearly, setYearly] = useState(true);
  const free = {
    name: "Free",
    price: "$0",
    period: "forever",
    blurb: "The full calculator plus a taste of live data. No card required.",
    features: [
      "Full deal calculator — analyze unlimited deals by hand",
      "Buy & Hold, BRRRR, and Fix & Flip models",
      "3 live property lookups a month",
      "5 sales-comp + 5 rental-comp lookups a month",
      "Save up to 3 properties",
      "Upload up to 5 property photos",
    ],
    cta: "Get started",
  };
  const pro = {
    name: "Pro",
    price: yearly ? "$20" : "$29.99",
    period: yearly ? "per month — $240 billed yearly" : "per month, billed monthly",
    blurb: "Analysis without limits, with live data doing the typing.",
    features: [
      "Everything in Free",
      "Full off-market deal feed",
      "Direct owner contact info",
      "Unlimited saved properties",
      "Unlimited property photos",
      "250 live property lookups a month",
      "Unlimited sales & rental comps",
      "Buy & Hold Projections",
      "Appreciation Projector",
      "Owner Lookup",
      "Property Records",
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
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 28 }}>
        <div style={{
          display: "inline-flex", padding: 4, background: "#fff",
          border: "1px solid " + C.border, borderRadius: 9999,
          boxShadow: "0 1px 2px 0 rgba(15,23,42,.05)",
        }}>
          {[["monthly", "Pay Monthly"], ["yearly", "Pay Yearly · save 33%"]].map(([id, label]) => {
            const active = (id === "yearly") === yearly;
            return (
              <button key={id} onClick={() => setYearly(id === "yearly")} style={{
                padding: "9px 18px", borderRadius: 9999, border: "none", cursor: "pointer",
                background: active ? C.orange : "transparent",
                color: active ? "#fff" : C.textSub,
                fontSize: 13.5, fontWeight: 700, fontFamily: F, letterSpacing: "-0.005em",
                transition: "background .15s, color .15s",
              }}>
                {label}
              </button>
            );
          })}
        </div>
      </div>
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
    a: "Yes. The Free plan includes the full calculator, 3 live property lookups a month, and up to 3 saved properties — no credit card required. When you want unlimited saves and the full deal feed, Pro is $29.99/mo, or $20/mo billed yearly. Cancel anytime.",
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

// The home page IS the How It Works tour, enriched with the conversion
// sections. The old hero home (Hero/TrustBar/HowItWorks) is retired but its
// components stay defined for reuse.
function HomePage({ onSignUp }) {
  return <HowItWorksPage onSignUp={onSignUp} home/>;
}

// -- Features page: overview grid + one section per strategy -------------------
const STRATEGIES = [
  {
    id: "rental",
    tone: {a: "#059669", d: "#047857"},
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
    tone: {a: "#7c3aed", d: "#6d28d9"},
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
    tone: {a: "#d97706", d: "#b45309"},
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
    tone: {a: "#E8731C", d: "#C2410C"},
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
      {STRATEGIES.map((s, i) => (
        <Section key={s.id} style={{ background: `linear-gradient(180deg, ${s.tone.a}0d 0%, ${s.tone.a}05 100%)`, padding: "64px 24px" }} hexes={i % 2 ? HEX_SETS.a : HEX_SETS.b}>
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: 56, alignItems: "center",
          }} className="dh-strat-grid">
            <div style={{ order: i % 2 ? 2 : 1 }}>
              <div style={{ marginBottom: 14 }}><Eyebrow tone={s.tone}>{s.eyebrow}</Eyebrow></div>
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
                      width: 19, height: 19, borderRadius: 9999, background: `${s.tone.a}14`,
                      border: `1px solid ${s.tone.a}55`, color: s.tone.d, flexShrink: 0,
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
                background: `radial-gradient(closest-side, ${s.tone.a}22, transparent 72%)`,
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
      <Features eyebrow={null}/>
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
      ["Cash-out sized from ARV", "The refinance pre-fills at 75% of your after-repair value, with your own refi rate and term."],
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
    <LegalPage title="Terms of Use" updated="July 20, 2026">
      <p>
        These Terms of Use ("Terms") are a license agreement between you and DealHive
        ("DealHive", "we", "us") governing your access to and use of the DealHive website,
        web application, and any mobile applications we release (together, the "Service").
        By creating an account or using the Service you agree to be bound by these Terms and
        by our <a href="/privacy">Privacy Policy</a>. If you do not agree, do not use the
        Service and discontinue any existing use.
      </p>

      <h2>1. License grant</h2>
      <p>
        The Service is licensed to you, not sold. We grant you a revocable, non-exclusive,
        non-transferable, limited right to access and use the Service on devices you own or
        control, strictly in accordance with these Terms and with any applicable rules of
        third-party platforms through which you access it (such as Apple or Google).
      </p>

      <h2>2. Restrictions on use</h2>
      <p>You agree that you will not:</p>
      <ul>
        <li>Copy, decompile, reverse engineer, disassemble, or attempt to derive the source code of the Service, or create derivative works from it;</li>
        <li>Scrape, harvest, bulk-export, resell, or redistribute data, listings, or content obtained through the Service;</li>
        <li>Use the Service to build, train, or improve a product or service that competes with DealHive;</li>
        <li>Remove, alter, or obscure any proprietary notices in the Service;</li>
        <li>Use the Service to send automated queries, spam, or unsolicited communications;</li>
        <li>Share, sell, or transfer your account, or access another user's account or data;</li>
        <li>Interfere with or disrupt the Service, or violate any applicable law, rule, or regulation in connection with your use.</li>
      </ul>

      <h2>3. Intellectual property</h2>
      <p>
        The Service — including its code, design, structure, algorithms, databases, and
        organization — and all copyrights, trademarks, trade secrets, and other intellectual
        property rights in it are and remain the property of DealHive and its licensors. No
        rights are granted to you by implication or otherwise except as expressly stated in
        these Terms. The Service may include third-party and open-source components, which
        are governed by their own license terms. You may not use the DealHive name, logo, or
        marks in any advertising or commercial manner without our prior written consent.
      </p>

      <h2>4. No transfer</h2>
      <p>
        You may not rent, lease, lend, sublicense, or transfer the Service, this license, or
        any rights granted under these Terms. Any attempted transfer in violation of this
        section is void.
      </p>

      <h2>5. Your information</h2>
      <p>
        You consent to our collection, storage, and use of information related to or derived
        from your use of the Service as described in our <a href="/privacy">Privacy
        Policy</a>. We may update the Privacy Policy from time to time by posting the revised
        version; your continued use of the Service after changes are posted constitutes
        acceptance of them.
      </p>

      <h2>6. Third-party content and services</h2>
      <p>
        The Service displays and relies on products, data, listings, estimates, imagery, and
        services created or provided by third parties — including property-data providers,
        listing sources, mapping services, and payment processors ("Third-Party Content and
        Services"). We do not investigate, monitor, verify, or endorse Third-Party Content
        and Services, and your use of them is at your sole risk. Your dealings with any
        third party — including any property owner or seller you locate through the
        Service — are between you and that party, and may be governed by that party's own
        terms and policies. We disclaim all warranties regarding the availability, quality,
        accuracy, completeness, or legality of Third-Party Content and Services, and we have
        no liability arising out of your access to or use of them.
      </p>

      <h2>7. Contacting property owners; not a brokerage</h2>
      <p>
        The Service may surface publicly listed contact information for property owners and
        sellers. You are solely responsible for how you use it. You agree to comply with all
        laws applicable to your outreach — including, without limitation, the Telephone
        Consumer Protection Act (TCPA), do-not-call registries, and applicable state
        solicitation and licensing laws — and you accept that contact and listing details
        may be incomplete or out of date. DealHive is an informational tool. We are not a
        real estate brokerage, agent, lender, appraiser, title company, or investment
        advisor, and nothing in the Service is an offer to buy or sell real estate.
      </p>

      <h2>8. Subscriptions and billing</h2>
      <ul>
        <li><strong>Subscription service.</strong> Certain features require an active, auto-renewing paid subscription ("Subscription"), billed monthly or yearly. We may modify the features, pricing, or availability of any plan at our discretion; price changes for existing subscribers take effect no earlier than their next renewal after notice.</li>
        <li><strong>Payment authorization.</strong> Payments are processed by our payment processor (Stripe). By starting a Subscription you authorize recurring charges to your payment method for each renewal period until you cancel. You also authorize credits to your payment method where refunds are issued.</li>
        <li><strong>Renewal and cancellation.</strong> Subscriptions renew automatically each billing cycle on the renewal date. You can cancel anytime in the app via Settings → Manage Billing, or by emailing <a href="mailto:support@dealhive.io">support@dealhive.io</a>. Cancellations made less than 24 hours before a renewal may not take effect until the following cycle. After cancellation, access continues through the end of the paid period.</li>
        <li><strong>Failed payments.</strong> You are responsible for keeping a valid payment method with sufficient funds. We may suspend or terminate Subscriptions with unpaid amounts, and we are not liable for fees your bank or card issuer may charge.</li>
        <li><strong>Taxes.</strong> Prices do not include applicable sales, use, VAT/GST, or similar taxes, which are your responsibility. We may collect and remit taxes where required.</li>
        <li><strong>Refunds.</strong> Charges are final and non-refundable except where required by law or where we determine, at our sole discretion, that a refund is appropriate. Refund requests can be sent to <a href="mailto:support@dealhive.io">support@dealhive.io</a> with an explanation.</li>
        <li><strong>Payment information.</strong> We may disclose payment-related information to third parties as reasonably required to process payments, resolve payment problems, comply with law or legal process, or as described in our Privacy Policy.</li>
      </ul>

      <h2>9. Term and termination</h2>
      <p>
        These Terms are effective until terminated. We may suspend or terminate your access
        to the Service at any time, for any or no reason, with or without notice. If you
        breach these Terms, this license terminates automatically. Upon termination you must
        cease all use of the Service. Sections 2 through 13 survive termination.
      </p>

      <h2>10. Disclaimer of warranties</h2>
      <p>
        <strong>Read this section carefully.</strong> The Service is provided "as is" and
        "as available," and your use of and reliance on it is at your sole risk. To the
        fullest extent permitted by law, we and our licensors and suppliers disclaim all
        warranties, express, implied, or statutory — including the implied warranties of
        merchantability, fitness for a particular purpose, and non-infringement. We do not
        warrant that the Service will meet your requirements; that it will be uninterrupted,
        timely, secure, or error-free; that any calculation, estimate, valuation, rent
        figure, comparable, projection, or report produced by the Service is accurate or
        complete; or that errors will be corrected.
      </p>
      <p>
        The Service produces analyses, valuations, and projections that are mathematical
        models based on assumptions, on data supplied by third parties that we do not
        independently verify, and on inputs you provide, which we also do not verify.
        Property records may not reflect recent additions or modifications. Actual results
        are affected by factors outside any model — including market conditions, interest
        rates, financing availability, regulation, and property condition — and may differ
        materially from projections. Nothing in the Service is a certified appraisal, a
        broker price opinion, or legal, tax, financial, or investment advice, and no
        assurance is given that projected results will be realized. Real estate investing
        involves substantial risk, including loss of capital. Always verify property
        details independently and consult licensed professionals before transacting.
      </p>

      <h2>11. Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, in no event shall DealHive or its
        affiliates, suppliers, or licensors be liable for any indirect, incidental,
        consequential, special, or exemplary damages arising out of or relating to your use
        of, or inability to use, the Service or any Third-Party Content and Services —
        including damages from relying on the Service in real estate purchasing or
        investment decisions — whether or not such damages were foreseeable. Our total
        aggregate liability to you for all claims, whether in contract, tort, or otherwise,
        shall not exceed the greater of (a) the amounts you paid us in the twelve months
        preceding the claim, or (b) one hundred dollars ($100). These limitations apply even
        if any stated remedy fails of its essential purpose.
      </p>

      <h2>12. Indemnification</h2>
      <p>
        You agree to indemnify, defend, and hold harmless DealHive and its affiliates,
        suppliers, and licensors, and their respective officers, agents, and employees, from
        any claim, loss, damage, fine, or expense (including reasonable attorneys' fees)
        arising out of (i) your use of the Service or Third-Party Content and Services;
        (ii) your breach of these Terms; (iii) your violation of law, including laws
        governing communications with property owners; (iv) your negligence or willful
        misconduct; or (v) your violation of any third party's rights. You are responsible
        for third-party claims relating to your use of the Service, and agree to notify us
        promptly of any such claims.
      </p>

      <h2>13. Compatibility</h2>
      <p>
        We do not warrant that the Service will be compatible or interoperable with your
        device, browser, or other software, and we are not liable for losses arising from
        compatibility or interoperability problems.
      </p>

      <h2>14. Governing law and disputes</h2>
      <p>
        These Terms are governed by the laws of the State of California, excluding its
        conflict-of-laws principles, and any disputes arising from them shall be brought in
        the state or federal courts located in California. The United Nations Convention on
        Contracts for the International Sale of Goods does not apply.
      </p>

      <h2>15. Miscellaneous</h2>
      <p>
        If any provision of these Terms is held invalid or unenforceable, the remainder
        stays in effect. Our failure to enforce a right is not a waiver of it. We may modify
        these Terms by posting the revised version on this page; your continued use of the
        Service after posting constitutes acceptance. These Terms, together with the
        documents referenced in them, are the entire agreement between you and us regarding
        the Service and supersede all prior understandings.
      </p>

      <h2>16. Contact</h2>
      <p>
        Questions about these Terms: <a href="mailto:support@dealhive.io">support@dealhive.io</a>
      </p>
    </LegalPage>
  );
}


// ==============================================================================
// How It Works — DealCheck-style tour with device mockups drawn in pure CSS
// (crisp at any scale, always on-brand, no screenshot assets to go stale).
// ==============================================================================

const HIW_PHOTO = "linear-gradient(135deg, #e8e2d8 0%, #f4efe7 38%, #d9d2c6 72%, #cfc6b8 100%)";
// Same hosted house photos the home hero uses — the warm gradient stays
// underneath as the fallback layer if a photo ever fails to load.
const HIW_IMGS = [
  "https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=720&h=400&q=80",
  "https://images.unsplash.com/photo-1564013799919-ab600027ffc6?auto=format&fit=crop&w=720&h=400&q=80",
  "https://images.unsplash.com/photo-1518780664697-55e3ad937233?auto=format&fit=crop&w=720&h=400&q=80",
];
// Slot 0 (the featured deal's photo on both devices) tries the repo-hosted
// kitchen shot first — upload public/kitchen-hero.jpg and it takes over;
// until then the hosted house photo shows, and the gradient backstops both.
const hiwPhoto = i => ({
  backgroundImage: `${i === 0 ? 'url("/kitchen-hero.jpg"), ' : ""}url("${HIW_IMGS[i % HIW_IMGS.length]}"), ${HIW_PHOTO}`,
  backgroundSize: "cover", backgroundPosition: "center",
});
// Named repo slots: drop a file with the given name into public/ on GitHub
// and it takes over that spot; the hosted photo and gradient backstop it.
const hiwSlot = (file, i) => ({
  backgroundImage: `url("/${file}"), url("${HIW_IMGS[i % HIW_IMGS.length]}"), ${HIW_PHOTO}`,
  backgroundSize: "cover", backgroundPosition: "center",
});

function HiwChip({children, tone}) {
  const tones = {
    price:  {bg: C.navyDeep, color: "#fff", border: C.navyDeep},
    rental: {bg: C.orangeSubtle, color: C.orangeDark, border: C.orangeBorder},
    plain:  {bg: "#fff", color: C.textSub, border: C.border},
  }[tone || "plain"];
  return (
    <span style={{background: tones.bg, color: tones.color, border: "1px solid " + tones.border,
      borderRadius: 999, padding: "0.22em 0.7em", fontWeight: 700, whiteSpace: "nowrap"}}>
      {children}
    </span>
  );
}

// The Deal View replica that lives inside both device screens. `s` scales the
// type so the same markup reads right on the monitor and the phone.
function HiwDealView({s = 1, compact = false}) {
  const fz = px => px * s;
  const metric = (label, value, green) => (
    <div style={{padding: `${fz(7)}px ${fz(6)}px`, textAlign: "center", background: "#fff"}}>
      <div style={{fontSize: fz(5.4), fontWeight: 700, color: C.textMuted, letterSpacing: ".08em",
        textTransform: "uppercase"}}>{label}</div>
      <div style={{fontSize: fz(10.5), fontWeight: 800, marginTop: 2,
        color: green ? C.cashPos : C.text}}>{value}</div>
    </div>
  );
  return (
    <div style={{fontFamily: F, background: "#fff"}}>
      <div style={{position: "relative", height: fz(compact ? 96 : 46), ...hiwPhoto(0)}}>
        <span style={{position: "absolute", top: fz(4), right: fz(4), width: fz(10), height: fz(10),
          borderRadius: "50%", background: "rgba(255,255,255,.95)", color: C.text,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: fz(6), fontWeight: 700}}>×</span>
        <span style={{position: "absolute", bottom: fz(4), right: fz(4), background: "rgba(20,25,35,.7)",
          color: "#fff", borderRadius: 999, padding: `${fz(1)}px ${fz(4)}px`, fontSize: fz(4.6),
          fontWeight: 700}}>1 / 2</span>
      </div>
      <div style={{padding: `${fz(6)}px ${fz(8)}px ${fz(8)}px`}}>
        <div style={{display: "flex", gap: fz(3), justifyContent: "center", fontSize: fz(5.6)}}>
          <HiwChip tone="price">$165,000</HiwChip>
          <HiwChip tone="rental">• Rental</HiwChip>
          <HiwChip tone="plain">Finance</HiwChip>
        </div>
        <div style={{textAlign: "center", marginTop: fz(4)}}>
          <div style={{fontSize: fz(8.6), fontWeight: 800, color: C.text, letterSpacing: "-0.01em"}}>
            7777 West Point Loma Boulevard
          </div>
          <div style={{fontSize: fz(5.8), color: C.textSub, marginTop: 1}}>San Diego, CA 92107</div>
        </div>
        <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: C.border,
          border: "1px solid " + C.border, borderRadius: fz(5), overflow: "hidden", marginTop: fz(5)}}>
          {metric("Cash Flow", "$820/mo", true)}
          {metric("Cap Rate", "10.80%")}
          {metric("CoC", "21.30%")}
          {metric("Total Spent", "$46,200")}
        </div>
        {compact ? (
          <div style={{display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 1,
            background: C.border, border: "1px solid " + C.border, borderRadius: fz(5),
            overflow: "hidden", marginTop: fz(5)}}>
            {[["1", "Beds"], ["1", "Baths"], ["725", "Sqft"],
              ["142.8k", "Lot"], ["1966", "Year"], ["Condo", "Type"]].map(([v, l]) => (
              <div key={l} style={{background: "#fff", textAlign: "center", padding: `${fz(4.6)}px 0`}}>
                <div style={{fontSize: fz(7.4), fontWeight: 800, color: C.text}}>{v}</div>
                <div style={{fontSize: fz(4.4), fontWeight: 700, color: C.textMuted,
                  textTransform: "uppercase", letterSpacing: ".06em", marginTop: 1}}>{l}</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{display: "flex", justifyContent: "center", gap: fz(6), marginTop: fz(5),
            fontSize: fz(5.4), color: C.textSub, fontWeight: 600}}>
            <span>1 bd</span><span>·</span><span>1 ba</span><span>·</span><span>725 sqft</span>
            <span>·</span><span>1966</span><span>·</span><span>Condo</span>
          </div>
        )}
        {!compact && (
          <div style={{marginTop: fz(5)}}>
            <div style={{fontSize: fz(5), fontWeight: 700, color: C.textMuted,
              letterSpacing: ".08em", textTransform: "uppercase", marginBottom: fz(2)}}>Analysis</div>
            {["Deal Calculator", "Buy & Hold Projections", "Appreciation Projector"].map(l => (
              <div key={l} style={{display: "flex", justifyContent: "space-between",
                alignItems: "center", padding: `${fz(3.6)}px ${fz(5)}px`,
                border: "1px solid " + C.border, borderRadius: fz(4), marginBottom: fz(2.4),
                fontSize: fz(6.4), fontWeight: 600, color: C.text, background: "#fff"}}>
                {l}<span style={{color: C.textMuted}}>›</span>
              </div>
            ))}
          </div>
        )}
        {compact && (
          <div style={{marginTop: fz(5)}}>
            <div style={{fontSize: fz(5), fontWeight: 700, color: C.textMuted,
              letterSpacing: ".08em", textTransform: "uppercase", marginBottom: fz(2)}}>Photos</div>
            <div style={{display: "flex", gap: fz(3)}}>
              <div style={{position: "relative", width: fz(26), height: fz(18), borderRadius: fz(3),
                ...hiwPhoto(0), border: "1px solid " + C.border}}>
                <span style={{position: "absolute", bottom: 1, left: 1, background: "rgba(20,25,35,.75)",
                  color: "#fff", borderRadius: 999, padding: `0 ${fz(2.4)}px`, fontSize: fz(3.6),
                  fontWeight: 800, textTransform: "uppercase"}}>Cover</span>
              </div>
              <div style={{width: fz(26), height: fz(18), borderRadius: fz(3),
                border: "1.4px dashed " + C.orangeBorder, background: C.orangeSubtle,
                color: C.orangeDark, display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: fz(4.4), fontWeight: 800}}>+ Add</div>
            </div>
            <div style={{fontSize: fz(5), fontWeight: 700, color: C.textMuted,
              letterSpacing: ".08em", textTransform: "uppercase", margin: `${fz(5)}px 0 ${fz(2)}px`}}>Analysis</div>
            {["Deal Calculator", "Buy & Hold Projections"].map(l => (
              <div key={l} style={{display: "flex", justifyContent: "space-between",
                alignItems: "center", padding: `${fz(3.6)}px ${fz(5)}px`,
                border: "1px solid " + C.border, borderRadius: fz(4), marginBottom: fz(2.4),
                fontSize: fz(6.4), fontWeight: 600, color: C.text, background: "#fff"}}>
                {l}<span style={{color: C.textMuted}}>›</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HiwDevices() {
  // On narrow screens the phone renders near full-width, so the replica
  // scales up ~1.5x to FILL the tall screen — the section edge then slices
  // through mid-content, DealCheck-style, instead of revealing empty glass.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 700px)");
    const upd = () => setNarrow(mq.matches);
    upd();
    mq.addEventListener("change", upd);
    return () => mq.removeEventListener("change", upd);
  }, []);
  return (
    <div className="dh-hiw-devices" style={{position: "relative", maxWidth: 860, margin: "44px auto 0", padding: "0 12px 44px"}}>
      {/* Monitor */}
      <div className="dh-hiw-monitor">
      <div style={{width: "88%",
        background: "linear-gradient(180deg, #f4f6f8 0%, #e0e4e8 55%, #c9cfd5 100%)",
        borderRadius: 18, padding: "1.6% 1.6% 2%", border: "1px solid #b7bdc4",
        boxShadow: "0 40px 80px -24px rgba(9,12,18,.5)"}}>
        <div style={{borderRadius: 8, overflow: "hidden", display: "flex", background: "#F7F5F1",
          aspectRatio: "16 / 9.8", border: "2px solid #171b20"}}>
          <div style={{width: "21%", background: C.navyDeep, padding: "3.4% 2.4%",
            display: "flex", flexDirection: "column", fontFamily: F}}>
            <img src="/logo-white.png" alt="DealHive"
              style={{width: "80%", display: "block", marginBottom: "12%"}}/>
            {["Dashboard", "Deals", "Deal Analyzer", "Settings"].map((l, i) => (
              <div key={l} style={{color: i === 0 ? "#fff" : "#8b96a5",
                background: i === 0 ? "rgba(255,255,255,.08)" : "transparent",
                borderRadius: 6, padding: "5% 7%", marginBottom: "3%",
                fontSize: "clamp(5px, 1vw, 10px)", fontWeight: i === 0 ? 700 : 500}}>{l}</div>
            ))}
          </div>
          <div style={{flex: 1, position: "relative", padding: "2.4%"}}>
            <div aria-hidden="true" style={{position: "absolute", inset: "4% 3%", display: "grid",
              gridTemplateColumns: "1fr 1fr", gap: "3%", opacity: .45, filter: "blur(1px)"}}>
              {[["$329,900", "650 Salisbury Road, Columbus, OH", "Rental"],
                ["$118,000", "2119 East 44th Street, Kansas City, MO", "By Owner"],
                ["$197,000", "3616 East 146th Street, Cleveland, OH", "Rental"],
                ["$165,000", "4205 Turney Road, Garfield Heights, OH", "Fix & Flip"]].map(([price, addr, tag], i) => (
                <div key={addr} style={{background: "#fff", borderRadius: 8,
                  border: "1px solid " + C.border, overflow: "hidden", fontFamily: F}}>
                  <div style={{height: "40%", ...hiwPhoto(i + 1)}}/>
                  <div style={{padding: "4% 6%"}}>
                    <div style={{display: "flex", justifyContent: "space-between",
                      alignItems: "center", gap: 4}}>
                      <span style={{fontSize: "clamp(5px, 0.85vw, 10px)", fontWeight: 800,
                        color: C.text}}>{price}</span>
                      <span style={{fontSize: "clamp(4px, 0.65vw, 8px)", fontWeight: 700,
                        color: C.orangeDark, background: C.orangeSubtle,
                        border: "1px solid " + C.orangeBorder, borderRadius: 999,
                        padding: "1% 5%", whiteSpace: "nowrap"}}>{tag}</span>
                    </div>
                    <div style={{fontSize: "clamp(4.5px, 0.7vw, 9px)", color: C.textSub,
                      marginTop: "2%", overflow: "hidden", textOverflow: "ellipsis",
                      whiteSpace: "nowrap"}}>{addr}</div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{position: "absolute", left: "50%", top: "50%",
              transform: "translate(-50%, -50%)", width: "58%",
              borderRadius: 10, overflow: "hidden", boxShadow: "0 18px 50px -12px rgba(9,12,18,.4)",
              border: "1px solid " + C.border}}>
              <HiwDealView s={0.98}/>
            </div>
          </div>
        </div>
      </div>
      <div style={{width: "9%", height: 26, margin: "0 auto",
        background: "linear-gradient(180deg, #d7dbe0, #b8bec5)",
        clipPath: "polygon(12% 0, 88% 0, 100% 100%, 0 100%)"}}/>
      <div style={{width: "26%", height: 9, margin: "0 auto",
        background: "linear-gradient(180deg, #e8ebee, #c2c8ce)", borderRadius: 999,
        boxShadow: "0 6px 14px -6px rgba(9,12,18,.4)"}}/>
      </div>
      {/* Phone — a real iPhone: tall 9:19 body, rounded bezel, Dynamic
          Island, side buttons; the app content crops like a scrolled screen. */}
      <div className="dh-hiw-phone" style={{position: "absolute", right: "1%", bottom: -8,
        width: "clamp(168px, 25%, 224px)", zIndex: 2}}>
        <div style={{position: "relative",
          background: "linear-gradient(155deg, #f79a52 0%, #E8731C 42%, #b85408 100%)",
          borderRadius: 38, padding: 9, aspectRatio: "9 / 19",
          boxShadow: "0 36px 72px -20px rgba(9,12,18,.6), 0 14px 44px -12px rgba(232,115,28,.45)"}}>
          <span style={{position: "absolute", left: -2.5, top: "20%", width: 3, height: "6%",
            background: "#a34a06", borderRadius: 2}}/>
          <span style={{position: "absolute", left: -2.5, top: "28.5%", width: 3, height: "6%",
            background: "#a34a06", borderRadius: 2}}/>
          <span style={{position: "absolute", right: -2.5, top: "23%", width: 3, height: "10%",
            background: "#a34a06", borderRadius: 2}}/>
          <div style={{position: "relative", borderRadius: 30, overflow: "hidden",
            background: "#fff", height: "100%"}}>
            <div style={{position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
              width: "30%", height: 13, borderRadius: 999, background: "#0e1319", zIndex: 2}}/>
            <div style={{position: "absolute", top: 7, left: 0, right: 0, zIndex: 2,
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "0 16px", color: "#fff", textShadow: "0 1px 3px rgba(9,12,18,.5)"}}>
              <span style={{fontSize: 11, fontWeight: 700, fontFamily: F}}>9:41</span>
              <span style={{display: "inline-flex", alignItems: "center", gap: 4}}>
                <span style={{display: "inline-flex", alignItems: "flex-end", gap: 1.5}}>
                  {[3, 5, 7, 9].map(h => (
                    <span key={h} style={{width: 2.5, height: h, borderRadius: 1,
                      background: "#fff"}}/>
                  ))}
                </span>
                <span style={{width: 19, height: 9.5, border: "1.4px solid rgba(255,255,255,.85)",
                  borderRadius: 3, display: "inline-flex", alignItems: "center", padding: 1.2}}>
                  <span style={{width: "72%", height: "100%", borderRadius: 1.4, background: "#fff"}}/>
                </span>
              </span>
            </div>
            <HiwDealView s={narrow ? 1.55 : 1.05} compact/>
          </div>
        </div>
      </div>
    </div>
  );
}

function HiwMiniCard({label, children}) {
  return (
    <div style={{background: "#fff", border: "1px solid " + C.border, borderRadius: 16,
      padding: "20px 20px 18px", boxShadow: "0 24px 48px -22px rgba(31,45,61,.22)",
      fontFamily: F, maxWidth: 420, width: "100%", margin: "0 auto"}}>
      {label && (
        <div style={{fontSize: 11, fontWeight: 700, color: C.orangeDark, letterSpacing: ".08em",
          textTransform: "uppercase", marginBottom: 12}}>{label}</div>
      )}
      {children}
    </div>
  );
}

function HiwRow({l, r, green, red, bold}) {
  return (
    <div style={{display: "flex", justifyContent: "space-between", gap: 12, padding: "7px 0",
      borderBottom: "1px solid " + C.borderSoft, fontSize: 13.5}}>
      <span style={{color: C.textSub, fontWeight: 500}}>{l}</span>
      <span style={{fontWeight: bold ? 800 : 700,
        color: green ? C.cashPos : red ? "#dc2626" : C.text, fontVariantNumeric: "tabular-nums"}}>{r}</span>
    </div>
  );
}

function HowItWorksPage({ onSignUp, home = false }) {
  const steps = [
    {
      title: "Type an address. We do the typing.",
      body: "Enter any U.S. address and DealHive pulls the property's details for you: price, beds, baths, square footage, year built, property taxes at your state's real rate, photos, and live value and rent estimates. Prefer typing it yourself? The calculator never needs a lookup.",
      visual: (
        <HiwMiniCard label="Property Data · Auto Filled">
          <HiwRow l="Value Estimate" r="$180,500" bold/>
          <HiwRow l="Rent Estimate" r="$1,850/mo" green/>
          <HiwRow l="Property Tax" r="$164/mo · auto"/>
          <div style={{display: "flex", gap: 8, marginTop: 12}}>
            {["thumb-1.avif", "thumb-2.jpg", "thumb-3.jpg"].map((f, i) => (
              <div key={f} style={{flex: 1, height: 52, borderRadius: 8, ...hiwSlot(f, i),
                border: "1px solid " + C.border}}/>
            ))}
          </div>
        </HiwMiniCard>
      ),
    },
    {
      title: "Shape the exact deal you'd actually do.",
      body: "Cash or financed, hard money or conventional, Buy & Hold, BRRRR, or Fix & Flip. Nine expense categories, itemizable closing and rehab costs, and investor defaults like 75% LTV. Every number is editable, and every change recalculates instantly.",
      visual: (
        <HiwMiniCard label="Rental Income">
          <HiwRow l="Gross Rent" r="$1,850 /mo" bold/>
          <HiwRow l="Vacancy Rate" r="8%"/>
          <div style={{fontSize: 11, fontWeight: 700, color: C.orangeDark, letterSpacing: ".08em",
            textTransform: "uppercase", margin: "14px 0 6px"}}>Operating Expenses</div>
          <HiwRow l="Itemized Total" r="$826 /mo" bold/>
          <div style={{marginTop: 12, display: "inline-flex", alignItems: "center", gap: 6,
            border: "1px solid " + C.border, borderRadius: 999, padding: "6px 14px",
            fontSize: 12.5, fontWeight: 700, color: C.textSub}}>✎ Itemize Expenses</div>
        </HiwMiniCard>
      ),
    },
    {
      title: "One Summary. The whole story.",
      body: "Every scenario ends in a single Summary that reads like the deal itself: the loan you take, the cash you put in, the exit event, and the life after it, with lender checks like DSCR for financed rentals. No hunting across sections for the verdict.",
      visual: (
        <HiwMiniCard label="Summary">
          <HiwRow l="Purchase Method" r="Finance"/>
          <HiwRow l="Exit Strategy" r="BRRRR"/>
          <HiwRow l="Out of Pocket" r="$80,608"/>
          <HiwRow l="Net Cash at Refi" r="$92,050" green bold/>
          <HiwRow l="Cash Flow (After Refi)" r="$375/mo" green bold/>
          <HiwRow l="Cap Rate" r="13.01%"/>
        </HiwMiniCard>
      ),
    },
    {
      title: "Comps and the owner, one tap deep.",
      body: "Browse recent sales comps and active rental comps for any address, then tap one for the full picture with a Street View photo. County records Owner Lookup shows who actually owns the property: their name, mailing address, and whether they live there.",
      visual: (
        <HiwMiniCard label="Sales Comps & ARV">
          <div style={{textAlign: "center", marginBottom: 10}}>
            <div style={{fontSize: 13, fontWeight: 800, color: "#2563eb"}}>Estimated Value</div>
            <div style={{fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em"}}>$180,500</div>
          </div>
          <HiwRow l="650 Salisbury Rd · 0.21 mi" r="$186,000"/>
          <HiwRow l="2119 E 44th St · 0.34 mi" r="$174,500"/>
          <div style={{marginTop: 12, background: C.orange, color: "#fff", borderRadius: 10,
            padding: "9px 0", textAlign: "center", fontSize: 13, fontWeight: 800}}>
            Find the Owner
          </div>
        </HiwMiniCard>
      ),
    },
    {
      title: "Fresh off-market deals, every single night.",
      body: "DealHive's feed restocks nightly with for sale by owner properties across the country's best cash flow metros. Full street addresses, real photos, the numbers already run, and owner contact info for Pro members. No agents, no gatekeepers.",
      visual: (
        <HiwMiniCard label="Tonight's Feed">
          {[["650 Salisbury Road, Columbus, OH", "$329,900"],
            ["2119 East 44th Street, Kansas City, MO", "$118,000"]].map(([a, p], i) => (
            <div key={a} style={{display: "flex", gap: 10, alignItems: "center", padding: "8px 0",
              borderBottom: "1px solid " + C.borderSoft}}>
              <div style={{width: 52, height: 38, borderRadius: 8,
                ...hiwSlot(i === 0 ? "feed-1.webp" : "feed-2.webp", i + 1),
                border: "1px solid " + C.border, flexShrink: 0}}/>
              <div style={{minWidth: 0, flex: 1}}>
                <div style={{fontSize: 12.5, fontWeight: 700, color: C.text, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{a}</div>
                <div style={{fontSize: 11.5, color: C.textSub, marginTop: 1}}>
                  <span style={{fontWeight: 800, color: C.text}}>{p}</span> · By Owner
                </div>
              </div>
            </div>
          ))}
        </HiwMiniCard>
      ),
    },
  ];

  return (
    <>
      <style>{`
        .dh-hiw-step { display: grid; grid-template-columns: 1fr 1fr; gap: 56px; align-items: center; }
        .dh-hiw-step.flip .dh-hiw-copy { order: 2; }
        @media (max-width: 860px) {
          .dh-hiw-step { grid-template-columns: 1fr; gap: 26px; }
          .dh-hiw-step.flip .dh-hiw-copy { order: 0; }
        }
        @media (max-width: 700px) {
          .dh-hiw-monitor { display: none; }
          .dh-hiw-devices { margin-top: 40px !important; padding-bottom: 0 !important;
            max-height: 560px; overflow: hidden; }
          .dh-hiw-phone { position: static !important; width: min(330px, 86vw) !important;
            margin: 0 auto; }
        }
      `}</style>

      {/* Hero */}
      <section style={{position: "relative", overflow: "hidden", padding: "52px 20px 0",
        background: `radial-gradient(ellipse at 18% 0%, ${C.navySoft} 0%, transparent 55%), linear-gradient(165deg, ${C.navyDeep} 0%, ${C.navy} 100%)`}}>
        <div aria-hidden="true" style={{position: "absolute", inset: 0}}>
          <Hex size={260} color={C.orange} opacity={0.14} blur={40} float={1} style={{top: -80, right: "6%"}}/>
          <Hex size={110} color={C.orange} opacity={0.2} outline float={2} style={{top: "30%", left: "-30px"}}/>
          <Hex size={54} color={C.orangeBorder} opacity={0.25} float={3} style={{bottom: "18%", right: "20%"}}/>
        </div>
        <div style={{position: "relative", maxWidth: 820, margin: "0 auto", textAlign: "center"}}>
          <h1 style={{fontSize: "clamp(34px, 5.4vw, 58px)", fontWeight: 800, fontFamily: F,
            letterSpacing: "-0.035em", lineHeight: 1.04, margin: "0 0 18px", color: "#fff"}}>
            From address to answer{" "}
            <span style={{color: C.orange, whiteSpace: "nowrap"}}>in seconds.</span>
          </h1>
          <p style={{fontSize: "clamp(15px, 1.8vw, 19px)", color: "#c3ccd8", fontFamily: F,
            lineHeight: 1.65, margin: "0 auto", maxWidth: 620}}>
            Our software makes it easy to analyze rental properties, BRRRR's, flips &
            multi-family buildings, estimate profits and find the best real estate deals.
          </p>
          <button onClick={onSignUp} style={{marginTop: 28, background: C.orange, color: "#fff",
            border: "none", borderRadius: 12, padding: "15px 34px", fontSize: 16, fontWeight: 800,
            fontFamily: F, cursor: "pointer", boxShadow: "0 16px 40px -10px rgba(232,115,28,.55)"}}>
            Try DealHive for Free
          </button>
          <div style={{fontSize: 12.5, color: "#8b96a5", fontFamily: F, marginTop: 12}}>
            Free forever plan · no credit card required
          </div>
        </div>
        <HiwDevices/>
      </section>

      {/* Steps */}
      <Section tint hexes={HEX_SETS.tint}>
        <SectionHeader
          eyebrow="The workflow"
          title="Accurate property analysis in just a few clicks."
          subtitle="Five steps between a raw address and a confident decision."
        />
        <div style={{maxWidth: 1020, margin: "0 auto", display: "flex", flexDirection: "column", gap: 84}}>
          {steps.map((s, i) => (
            <div key={s.title} className={"dh-hiw-step" + (i % 2 ? " flip" : "")}>
              <div className="dh-hiw-copy">
                <div style={{display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 34, height: 34, borderRadius: 10, background: C.orangeSubtle,
                  border: "1px solid " + C.orangeBorder, color: C.orangeDark, fontWeight: 800,
                  fontFamily: F, fontSize: 15, marginBottom: 14}}>{i + 1}</div>
                <h3 style={{fontSize: "clamp(22px, 2.6vw, 30px)", fontWeight: 800, fontFamily: F,
                  letterSpacing: "-0.025em", lineHeight: 1.15, margin: "0 0 12px", color: C.text}}>
                  {s.title}
                </h3>
                <p style={{fontSize: 15.5, color: C.textSub, fontFamily: F, lineHeight: 1.7, margin: 0}}>
                  {s.body}
                </p>
              </div>
              <div>{s.visual}</div>
            </div>
          ))}
        </div>
      </Section>

      {home && (
        <>
          <Features/>
          <NumbersStrip/>
          <Pricing onSignUp={onSignUp}/>
          <FAQ/>
        </>
      )}

      {/* CTA */}
      <Section dark hexes={HEX_SETS.dark}>
        <div style={{textAlign: "center", maxWidth: 640, margin: "0 auto"}}>
          <h2 style={{fontSize: "clamp(26px, 3.6vw, 40px)", fontWeight: 800, fontFamily: F,
            letterSpacing: "-0.03em", color: "#fff", margin: "0 0 14px", lineHeight: 1.1}}>
            Analyze your first deal in the next five minutes.
          </h2>
          <p style={{fontSize: 16, color: "#c3ccd8", fontFamily: F, lineHeight: 1.65, margin: "0 0 26px"}}>
            The calculator is free forever. The full feed is one tap away when you're ready.
          </p>
          <button onClick={onSignUp} style={{background: C.orange, color: "#fff", border: "none",
            borderRadius: 12, padding: "15px 34px", fontSize: 16, fontWeight: 800, fontFamily: F,
            cursor: "pointer", boxShadow: "0 16px 40px -10px rgba(232,115,28,.55)"}}>
            Get Started Free
          </button>
        </div>
      </Section>
    </>
  );
}

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
  "/how-it-works": "How DealHive Works",
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
    page === "/how-it-works" ? <HowItWorksPage onSignUp={onSignUp}/> :
    page === "/privacy"  ? <PrivacyPage/> :
    page === "/terms"    ? <TermsPage/> :
    <HomePage onSignUp={onSignUp}/>;

  return (
    <div style={{ background: C.bg, color: C.text, minHeight: "100vh" }}>
      <style>{`
        @keyframes dhFloat1 { from { transform: translateY(0); }    to { transform: translateY(-14px); } }
        @keyframes dhFloat2 { from { transform: translateY(-8px); } to { transform: translateY(10px); } }
        @media (max-width: 860px) {
          .dh-strat-grid { grid-template-columns: 1fr !important; gap: 28px !important; }
          .dh-strat-grid > div { order: unset !important; }
        }
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
