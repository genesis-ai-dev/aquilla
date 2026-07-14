import { useEffect, useRef } from "react"
import { useBrand } from "@/branding/use-brand"
import { AppTooltip } from "@/components/ui/tooltip"
import { useMarketingShell } from "../Homepage/useMarketingShell"
import "../Homepage/homepage.css"

const DISCORD_URL = "https://discord.gg/T2EndwXe4W"

/** Qualitative roadmap — no dates. Edit phases here to keep /beta current. */
const ROADMAP: { phase: string; tone: string; blurb: string; items: string[] }[] = [
  {
    phase: "Now",
    tone: "Available today",
    blurb: "Everything below is live in the workspace — free, for everyone.",
    items: [
      "Text & audio translation under one roof",
      "Captions & subtitles",
      "Low-resource language drafting",
      "Real-time guidance & back-translation",
      "Living Memory — fix it once, the system learns",
      "Review support you can inspect at a glance",
      "Cloud sync & team collaboration",
      "On-device speech capabilities (cloud models also available)",
    ],
  },
  {
    phase: "Next",
    tone: "In progress",
    blurb: "What we're actively building toward.",
    items: [
      "Video-based workflows",
      "Image translation",
      "Oral-story translation",
      "Richer terminology and glossary tooling",
      "Deeper in-flow AI assistance",
    ],
  },
  {
    phase: "Later",
    tone: "On the horizon",
    blurb: "Where we're headed once the foundations are solid.",
    items: [
      "Deeper automations across the translation loop",
      "Integrations with the tools your team already uses",
    ],
  },
]

export function BetaPage() {
  const brand = useBrand()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { theme, toggleTheme } = useMarketingShell()

  // Reveal-on-scroll, mirroring the homepage.
  useEffect(() => {
    const els = rootRef.current?.querySelectorAll<HTMLElement>(".aq-reveal") ?? []
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target) } }),
      { threshold: 0.16, rootMargin: "0px 0px -8% 0px" },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])

  const Mark = brand.logo.Mark

  return (
    <div className="aq-root" ref={rootRef} data-theme={theme}>
      <div className="aq-atmosphere" aria-hidden="true">
        <div className="aq-glow aq-glow-dawn" />
        <div className="aq-glow aq-glow-blue" />
        <div className="aq-grain" />
      </div>

      {/* ── Nav ───────────────────────────────────────────────────────── */}
      <nav className="aq-nav" data-scrolled={true}>
        <div className="aq-container aq-nav-inner">
          <a href="/homepage" className="aq-brand">
            <Mark className="aq-brand-mark" />
            <span className="aq-brand-name">{brand.app.name}</span>
          </a>
          <div className="aq-nav-cta">
            <AppTooltip content={theme === "dark" ? "Light mode" : "Dark mode"}>
              <button
                type="button"
                className="aq-theme-toggle"
                onClick={toggleTheme}
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              >
                {theme === "dark" ? <IconSun /> : <IconMoon />}
              </button>
            </AppTooltip>
            <a href="/homepage" className="aq-btn aq-btn-ghost aq-btn-sm">Home</a>
            <a href="/onboarding" className="aq-btn aq-btn-gold aq-btn-sm">Sign up free</a>
          </div>
        </div>
      </nav>

      <main className="aq-shell" id="top" aria-label="Beta status content">
        {/* ── Hero ────────────────────────────────────────────────────── */}
        <section className="aq-container aq-hero">
          <div className="aq-hero-eyebrow aq-load aq-d1">
            <span className="aq-dot" aria-hidden="true" /> Public beta
          </div>
          <h1 className="aq-display aq-load aq-d2">
            Aquilla is in <span className="aq-gold-text aq-display-italic">public beta.</span>
          </h1>
          <p className="aq-hero-sub aq-load aq-d3">
            The workspace is live and free to use today — and it's moving fast. Read on to learn what's shipping now, and where we're headed.
          </p>
          <div className="aq-hero-actions aq-load aq-d4">
            <a href="/onboarding" className="aq-btn aq-btn-gold aq-btn-lg">Sign up free</a>
            <a href="#roadmap" className="aq-btn aq-btn-ghost aq-btn-lg">See the roadmap <IconArrow /></a>
          </div>
        </section>

        {/* ── What beta means ─────────────────────────────────────────── */}
        <section className="aq-container aq-section" id="what">
          <div className="aq-head aq-center aq-reveal">
            <span className="aq-eyebrow">No fine print</span>
            <h2 className="aq-display">What "beta" means here.</h2>
            {/* <p>
              Beta isn't a paywall or a waitlist. It means the product is real and in your hands —
              and still evolving quickly. Here's the deal.
            </p> */}
          </div>
          <div className="aq-beta-cards aq-reveal">
            {[
              { t: "Free", d: "The whole workspace is free for everyone — no credit card, no trial clock. Our mission is to accelerate translation, not bill you for it. (Usage caps are in place for now by default to keep the service available for everyone.)" },
              { t: "It's evolving fast", d: "Features may move, improve, or occasionally break. We ship often. If something looks different next week, this is why." },
              { t: "Your feedback steers it", d: "What you tell us directly shapes what ships next. The fastest way in is our community." },
            ].map((c) => (
              <div className="aq-beta-card" key={c.t}>
                <IconCheck />
                <div>
                  <h3>{c.t}</h3>
                  <p>{c.d}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="aq-reveal" style={{ textAlign: "center", marginTop: 28 }}>
            <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="aq-btn aq-btn-ghost">
              <IconChat /> Join our Discord
            </a>
          </div>
        </section>

        {/* ── Roadmap ─────────────────────────────────────────────────── */}
        <section className="aq-container aq-section" id="roadmap">
          <div className="aq-head aq-center aq-reveal">
            <span className="aq-eyebrow">Roadmap</span>
            <h2 className="aq-display">Now, next, and later.</h2>
            <p>
              Here's the shape of where the product is going.
            </p>
          </div>
          <div className="aq-roadmap aq-reveal">
            {ROADMAP.map((col) => (
              <div className="aq-road-col" key={col.phase} data-phase={col.phase.toLowerCase()}>
                <div className="aq-road-head">
                  <span className="aq-road-phase">{col.phase}</span>
                  <span className="aq-road-tone">{col.tone}</span>
                </div>
                <p className="aq-road-blurb">{col.blurb}</p>
                <ul className="aq-feature-list">
                  {col.items.map((it) => (
                    <li key={it}><IconCheck /> {it}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="aq-reveal" style={{ textAlign: "center", marginTop: 28, color: "var(--aq-faint)", fontSize: 13.5 }}>
            Timelines are directional and may shift as we learn. Last updated June 2026.
          </div>
        </section>

        {/* ── Final CTA ───────────────────────────────────────────────── */}
        <section className="aq-container aq-section" style={{ paddingTop: 0 }}>
          <div className="aq-cta-band aq-reveal">
            <h2 className="aq-display">Translation, <span className="aq-gold-text aq-display-italic">lifted.</span></h2>
            <p>It's free, it's live, and it gets better every week. Jump in and help shape what comes next.</p>
            <div className="aq-cta-actions">
              <a href="/onboarding" className="aq-btn aq-btn-gold aq-btn-lg">Sign up free</a>
              <a href="/homepage" className="aq-btn aq-btn-ghost aq-btn-lg">Back to homepage</a>
            </div>
          </div>
        </section>
      </main>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <footer className="aq-footer">
        <div className="aq-container">
          <div className="aq-footer-base">
            <span>© {new Date().getFullYear()} {brand.app.name} · {brand.deploy?.domain ?? "aquilla.app"}</span>
            <span>Made for the All-Access Goals — Scripture for every language by 2033.</span>
          </div>
        </div>
      </footer>
    </div>
  )
}

/* ── Icons ──────────────────────────────────────────────────────────────── */
function IconArrow() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" /></svg> }
function IconCheck() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 8.5l3 3 7-7.5" strokeLinecap="round" strokeLinejoin="round" /></svg> }
function IconSun() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="9" cy="9" r="3.6" /><path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M14.3 3.7l-1.4 1.4M5.1 12.9l-1.4 1.4" strokeLinecap="round" /></svg> }
function IconMoon() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M15 10.5A6.5 6.5 0 0 1 7.5 3a6.5 6.5 0 1 0 7.5 7.5z" strokeLinejoin="round" /></svg> }
function IconChat() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3 2.5V11.5h-0a2 2 0 0 1-1.5-2z" strokeLinejoin="round" /></svg> }
