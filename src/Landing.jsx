// DealHive marketing site — public landing page at dealhive.io.
// Lives at the root path when the visitor isn't logged in. CTAs route to
// /signup or /login which App.jsx maps to the AuthPage.
//
// Self-contained: no shared imports from App.jsx (which would force the
// 400KB app bundle to load just to see the marketing site). Uses the
// same brand palette inlined so future copy/design tweaks land here only.

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
  bgTint:       "#FFF7ED",
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
  globe:   <Icon d={<><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></>}/>,
  moon:    <Icon d={<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>}/>,
  zap:     <Icon d={<path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>} fill="currentColor" stroke="none"/>,
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

function Section({ children, dark, tint, style, id }) {
  return (
    <section id={id} style={{
      padding: "80px 24px",
      background: dark ? C.navyDeep : tint ? C.orangeSubtle : C.bg,
      color: dark ? "#fff" : C.text,
      borderTop: tint ? "1px solid " + C.orangeBorder : "none",
      borderBottom: tint ? "1px solid " + C.orangeBorder : "none",
      ...style,
    }}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>{children}</div>
    </section>
  );
}

function SectionHeader({ eyebrow, title, subtitle, dark, center = true }) {
  return (
    <div style={{ textAlign: center ? "center" : "left", marginBottom: 56, maxWidth: 720, margin: center ? "0 auto 56px" : "0 0 56px" }}>
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

// -- Mock deal card used in the hero ------------------------------------------
// `photo` is the gradient fallback (shown if `imgUrl` fails or while loading);
// `imgUrl` is the real photo (Unsplash, hosted, whatever). Swap imgUrls in
// HeroVisual below to change which photos appear in the hero.
function MockDealCard({ photo, imgUrl, address, price, rent, capRate, cashflow, beds, baths, sqft, badge }) {
  const [imgFailed, setImgFailed] = useState(false);
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
        {imgUrl && !imgFailed && (
          <img src={imgUrl} alt=""
            loading="lazy" decoding="async"
            onError={() => setImgFailed(true)}
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
          <Stat label="Rent" value={"$" + rent} />
          <Stat label="Cap rate" value={capRate + "%"} accent />
          <Stat label="Cash flow" value={"$" + cashflow + "/mo"} accent />
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
    <div style={{
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
          badge="New today"
        />
        <div style={{ transform: "translateX(40px)" }}>
          <MockDealCard
            photo={["#dbeafe", "#bfdbfe"]}
            imgUrl="https://images.unsplash.com/photo-1564013799919-ab600027ffc6?auto=format&fit=crop&w=720&h=400&q=80"
            address="Detroit, MI 48227"
            price={62000} rent={1350} capRate={16.8} cashflow={744}
            beds={3} baths={2} sqft={1380}
            badge="Off-market"
          />
        </div>
        <div style={{ transform: "translateX(-30px)" }}>
          <MockDealCard
            photo={["#e0e7ff", "#c7d2fe"]}
            imgUrl="https://images.unsplash.com/photo-1570129477492-45c003edd2be?auto=format&fit=crop&w=720&h=400&q=80"
            address="Memphis, TN 38106"
            price={75000} rent={1200} capRate={12.4} cashflow={485}
            beds={3} baths={1} sqft={1180}
            badge="Wholesale"
          />
        </div>
      </div>
    </div>
  );
}

// -- Top nav ------------------------------------------------------------------
function TopNav({ onSignIn, onSignUp }) {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const scrollTo = id => {
    setMobileOpen(false);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const links = [
    ["Features", "features"],
    ["How it works", "how"],
    ["Pricing", "pricing"],
    ["FAQ", "faq"],
  ];
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
        <a href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
          <img src="/logo.png" alt="DealHive" style={{ height: 30, width: "auto" }}/>
        </a>

        <div style={{ display: "flex", alignItems: "center", gap: 32 }} className="dh-nav-links">
          {links.map(([label, id]) => (
            <button key={id} onClick={() => scrollTo(id)}
              style={{
                background: "transparent", border: "none", padding: 0, cursor: "pointer",
                color: C.text, fontSize: 14, fontWeight: 500, fontFamily: F, letterSpacing: "-0.005em",
              }}>
              {label}
            </button>
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
        <div style={{
          borderTop: "1px solid " + C.border, background: "#fff",
          padding: "12px 24px 20px", display: "flex", flexDirection: "column", gap: 4,
        }}>
          {links.map(([label, id]) => (
            <button key={id} onClick={() => scrollTo(id)}
              style={{
                background: "transparent", border: "none", textAlign: "left",
                padding: "12px 4px", cursor: "pointer", fontFamily: F, fontSize: 15,
                fontWeight: 500, color: C.text,
              }}>
              {label}
            </button>
          ))}
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
    <section style={{
      position: "relative", overflow: "hidden",
      padding: "72px 24px 96px",
      background: `radial-gradient(ellipse at 80% 0%, ${C.orangeSubtle} 0%, transparent 50%), ${C.bg}`,
    }}>
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 1,
        background: `linear-gradient(90deg, transparent, ${C.border}, transparent)`,
      }}/>
      <div style={{
        maxWidth: 1180, margin: "0 auto",
        display: "grid", gridTemplateColumns: "1.05fr 1fr", gap: 64, alignItems: "center",
      }} className="dh-hero-grid">
        <div>
          <div style={{ marginBottom: 24 }}>
            <Eyebrow>Updated nightly · 6 cash-flow markets</Eyebrow>
          </div>
          <h1 style={{
            fontSize: "clamp(36px, 5.6vw, 64px)", fontWeight: 700, fontFamily: F,
            letterSpacing: "-0.035em", lineHeight: 1.02, margin: "0 0 22px",
            color: C.text,
          }}>
            Off-market deals.<br/>
            <span style={{
              background: `linear-gradient(135deg, ${C.orange} 0%, ${C.orangeDark} 100%)`,
              WebkitBackgroundClip: "text", backgroundClip: "text",
              WebkitTextFillColor: "transparent", color: "transparent",
            }}>
              Pre-analyzed. Every morning.
            </span>
          </h1>
          <p style={{
            fontSize: "clamp(16px, 1.7vw, 19px)", color: C.textSub, fontFamily: F,
            lineHeight: 1.55, margin: "0 0 32px", maxWidth: 540,
          }}>
            DealHive scans hundreds of wholesale and off-market listings every night across six high cash-flow markets. By morning, the deals that actually pencil are waiting in your feed — already analyzed.
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 32 }}>
            <Button onClick={onSignUp} size="lg">
              Get started — it's free {I.arrow}
            </Button>
            <Button onClick={() => document.getElementById("how")?.scrollIntoView({ behavior: "smooth" })}
              variant="secondary" size="lg">
              {I.play} See how it works
            </Button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 13, color: C.textMuted, fontFamily: F }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: C.cashPos }}>{I.check}</span> No credit card
            </div>
            <div style={{ width: 1, height: 14, background: C.border }}/>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: C.cashPos }}>{I.check}</span> Free tier forever
            </div>
            <div style={{ width: 1, height: 14, background: C.border }}/>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: C.cashPos }}>{I.check}</span> Cancel anytime
            </div>
          </div>
        </div>

        <div className="dh-hero-visual">
          <HeroVisual/>
        </div>
      </div>

      <style>{`
        @media (max-width: 920px) {
          .dh-hero-grid { grid-template-columns: 1fr !important; gap: 56px !important; }
          .dh-hero-visual { max-width: 380px; margin: 0 auto; }
        }
      `}</style>
    </section>
  );
}

// -- Trust bar (markets covered) ----------------------------------------------
function TrustBar() {
  const markets = ["Cleveland, OH", "Detroit, MI", "Memphis, TN", "Birmingham, AL", "Indianapolis, IN", "Kansas City, MO"];
  return (
    <section style={{
      padding: "32px 24px", borderTop: "1px solid " + C.border, borderBottom: "1px solid " + C.border,
      background: C.bgSoft,
    }}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: C.textMuted, fontFamily: F,
          letterSpacing: "0.12em", textTransform: "uppercase", textAlign: "center", marginBottom: 16,
        }}>
          Now covering 6 high cash-flow markets
        </div>
        <div style={{
          display: "flex", justifyContent: "center", flexWrap: "wrap", gap: "20px 40px",
        }}>
          {markets.map(m => (
            <div key={m} style={{
              display: "flex", alignItems: "center", gap: 8,
              fontSize: 14, fontWeight: 600, color: C.navy, fontFamily: F,
            }}>
              <span style={{ color: C.orange }}>{I.home}</span> {m}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// -- How it works -------------------------------------------------------------
function HowItWorks() {
  const steps = [
    {
      n: "01",
      title: "We scan overnight",
      body: "Every night, our pipeline pulls fresh wholesale assignments and off-market listings from across 6 cash-flow markets. Hundreds of properties, filtered down to the ones that actually pencil.",
    },
    {
      n: "02",
      title: "Every deal comes pre-analyzed",
      body: "Cap rate, cash flow, BRRRR potential, fix-and-flip numbers — calculated automatically against the pro forma. No spreadsheet required.",
    },
    {
      n: "03",
      title: "Save, analyze, act",
      body: "Tap to save deals you like. Open them in the analyzer to tweak numbers, run comps, and underwrite. All from your phone, all in one place.",
    },
  ];
  return (
    <Section id="how">
      <SectionHeader
        eyebrow="How it works"
        title="The deal-finding loop, automated."
        subtitle="DealHive does the boring 6am scrolling for you. You wake up to a feed of deals that already make sense."
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
              color: C.orangeSubtle, lineHeight: 1, marginBottom: 14,
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
function Features() {
  const feats = [
    { icon: I.bolt,   title: "Off-market deal feed",
      body: "Wholesale assignments, off-market listings, and recently-listed cash-flow rentals — refreshed every night before you wake up." },
    { icon: I.chart,  title: "Built-in deal analyzer",
      body: "Tap any deal to open it in the analyzer pre-filled with the numbers. Adjust your purchase price, rent, repairs — recalculates instantly." },
    { icon: I.brrrr,  title: "Buy-and-hold, BRRRR, or flip",
      body: "Every deal scored against three strategies. See which model wins before you make an offer." },
    { icon: I.search, title: "Comps that actually match",
      body: "Pull rental and sale comps for any address. See what the market really pays — not what Zillow guesses." },
    { icon: I.star,   title: "Saved deals & alerts",
      body: "Watchlist your favorites, get notified when new deals hit your target markets. Never miss the one that prices right." },
    { icon: I.device, title: "Mobile-first",
      body: "Designed for driving for dollars and quick decisions. Underwrite on your phone in the parking lot — full power, no compromise." },
  ];
  return (
    <Section id="features" style={{ background: C.bgSoft }}>
      <SectionHeader
        eyebrow="Features"
        title="Everything you need to find your next deal."
        subtitle="Not a CRM. Not a course. A deal-flow tool built by investors for investors."
      />
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20,
      }}>
        {feats.map(f => (
          <div key={f.title} style={{
            padding: 26, background: "#fff", border: "1px solid " + C.border, borderRadius: 14,
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
              width: 40, height: 40, borderRadius: 10,
              background: C.orangeSubtle, border: "1px solid " + C.orangeBorder, color: C.orangeDark,
              display: "flex", alignItems: "center", justifyContent: "center",
              marginBottom: 14,
            }}>
              {f.icon}
            </div>
            <h3 style={{
              fontSize: 16, fontWeight: 700, fontFamily: F, letterSpacing: "-0.015em",
              margin: "0 0 8px", color: C.text,
            }}>
              {f.title}
            </h3>
            <p style={{ fontSize: 14, color: C.textSub, fontFamily: F, lineHeight: 1.55, margin: 0 }}>
              {f.body}
            </p>
          </div>
        ))}
      </div>
    </Section>
  );
}

// -- Big "by the numbers" strip ----------------------------------------------
function NumbersStrip() {
  const stats = [
    { v: "300+", l: "Deals analyzed nightly" },
    { v: "6",    l: "Cash-flow markets" },
    { v: "<60s", l: "From listing to your feed" },
    { v: "$0",   l: "To get started" },
  ];
  return (
    <Section dark style={{ padding: "64px 24px" }}>
      <div style={{
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
    blurb: "Browse a preview of the feed and analyze deals manually. Great for kicking the tires.",
    features: [
      "Preview of nightly deal feed",
      "Built-in deal analyzer",
      "Buy-and-hold, BRRRR, and flip models",
      "Save up to 5 deals to your watchlist",
    ],
    cta: "Get started",
  };
  const pro = {
    name: "Pro",
    price: "$29.99",
    period: "per month",
    blurb: "The full picture. Every deal, every market, every morning — no limits.",
    features: [
      "Full deal feed — all markets, all deals",
      "Exact addresses (not just neighborhoods)",
      "Pre-filled analyzer on every deal",
      "Unlimited saved deals",
      "Rent and sale comps for any address",
      "Cancel anytime",
    ],
    cta: "Start free, upgrade anytime",
    popular: true,
  };

  return (
    <Section id="pricing" tint>
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
function FAQ() {
  const items = [
    {
      q: "What is DealHive?",
      a: "DealHive is a deal-finding tool for real estate investors. Every night, we scan the off-market wholesale market across six high cash-flow cities. By morning, deals that pencil out are in your feed — already analyzed against buy-and-hold, BRRRR, and fix-and-flip models. You browse, save the ones you like, and underwrite further in the built-in analyzer.",
    },
    {
      q: "Where do the deals come from?",
      a: "Off-market wholesale assignment lists, recently-listed cash-flow rentals, and public records — all aggregated nightly. We focus on properties that already make sense at list price, not flips that depend on hot markets.",
    },
    {
      q: "Which markets do you cover?",
      a: "Cleveland, Detroit, Memphis, Birmingham, Indianapolis, and Kansas City. These are the markets where the numbers still work — strong rent-to-price ratios, reasonable taxes, and active wholesale networks. We're expanding to more cities through the year.",
    },
    {
      q: "Can I try it before paying?",
      a: "Yes. The Free plan lets you preview deals, use the analyzer, and save up to 5 deals to your watchlist — no credit card required. When you want the full feed and exact addresses, Pro is $29.99/mo, cancel anytime.",
    },
    {
      q: "Do you guarantee these deals make money?",
      a: "No tool can guarantee that — and we wouldn't trust one that did. DealHive does the work of finding and pre-analyzing deals so you can underwrite faster, but you're still the one making the buy decision. Always verify numbers, walk the property, and run your own comps.",
    },
    {
      q: "Is my data private?",
      a: "Yes. Your saved deals, notes, and account information are private to your account. We don't sell user data, we don't share watchlists with sellers, and you can delete your account and data anytime from Settings.",
    },
  ];
  const [open, setOpen] = useState(0);
  return (
    <Section id="faq">
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
function FinalCTA({ onSignUp }) {
  return (
    <Section dark style={{
      padding: "80px 24px",
      background: `radial-gradient(ellipse at 50% 50%, ${C.navySoft} 0%, ${C.navyDeep} 70%)`,
    }}>
      <div style={{ textAlign: "center", maxWidth: 720, margin: "0 auto" }}>
        <h2 style={{
          fontSize: "clamp(28px, 4.4vw, 44px)", fontWeight: 700, fontFamily: F,
          letterSpacing: "-0.03em", lineHeight: 1.1, margin: "0 0 16px", color: "#fff",
        }}>
          Stop scrolling Zillow at 6am.
        </h2>
        <p style={{
          fontSize: "clamp(15px, 1.8vw, 18px)", color: "rgba(255,255,255,.7)",
          fontFamily: F, margin: "0 0 32px", lineHeight: 1.55,
        }}>
          DealHive does the work overnight. You wake up to deals worth your time. Get started for free — no card, no commitment.
        </p>
        <Button onClick={onSignUp} size="lg" style={{ padding: "16px 28px", fontSize: 16 }}>
          Get started — it's free {I.arrow}
        </Button>
      </div>
    </Section>
  );
}

// -- Footer -------------------------------------------------------------------
function Footer({ onSignIn, onSignUp }) {
  const year = new Date().getFullYear();
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
            <img src="/logo.png" alt="DealHive" style={{ height: 28, width: "auto", marginBottom: 14 }}/>
            <p style={{ fontSize: 13, color: C.textSub, lineHeight: 1.55, margin: 0, maxWidth: 320 }}>
              The off-market deal feed for real estate investors. Updated nightly across six cash-flow markets.
            </p>
          </div>
          <FooterCol title="Product" links={[
            ["Features", () => document.getElementById("features")?.scrollIntoView({ behavior: "smooth" })],
            ["How it works", () => document.getElementById("how")?.scrollIntoView({ behavior: "smooth" })],
            ["Pricing", () => document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth" })],
            ["FAQ", () => document.getElementById("faq")?.scrollIntoView({ behavior: "smooth" })],
          ]}/>
          <FooterCol title="Account" links={[
            ["Sign in", onSignIn],
            ["Get started", onSignUp],
          ]}/>
          <FooterCol title="Legal" links={[
            ["Privacy", () => window.location.assign("/privacy")],
            ["Terms", () => window.location.assign("/terms")],
            ["Contact", () => window.location.assign("mailto:support@dealhive.io")],
          ]}/>
        </div>
        <div style={{
          paddingTop: 24, borderTop: "1px solid " + C.border,
          display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap",
        }}>
          <div style={{ fontSize: 12, color: C.textMuted, fontFamily: F }}>
            © {year} DealHive. All rights reserved.
          </div>
          <div style={{ fontSize: 12, color: C.textMuted, fontFamily: F }}>
            Made for investors who'd rather close deals than scroll Zillow.
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

function FooterCol({ title, links }) {
  return (
    <div>
      <div style={{
        fontSize: 12, fontWeight: 700, color: C.text, letterSpacing: "0.06em",
        textTransform: "uppercase", marginBottom: 14, fontFamily: F,
      }}>
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {links.map(([label, onClick]) => (
          <button key={label} onClick={onClick}
            style={{
              background: "transparent", border: "none", padding: 0, cursor: "pointer",
              textAlign: "left", fontSize: 13.5, color: C.textSub, fontFamily: F,
            }}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// -- Top-level landing export -------------------------------------------------
export default function Landing({ onSignIn, onSignUp }) {
  useEffect(() => { window.scrollTo(0, 0); }, []);
  return (
    <div style={{ background: C.bg, color: C.text, minHeight: "100vh" }}>
      <TopNav onSignIn={onSignIn} onSignUp={onSignUp}/>
      <Hero onSignUp={onSignUp}/>
      <TrustBar/>
      <HowItWorks/>
      <Features/>
      <NumbersStrip/>
      <Pricing onSignUp={onSignUp}/>
      <FAQ/>
      <FinalCTA onSignUp={onSignUp}/>
      <Footer onSignIn={onSignIn} onSignUp={onSignUp}/>
    </div>
  );
}
