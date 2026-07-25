import { Component, type ReactNode, useEffect, useRef, useState } from "react"
import { useBrand } from "@/branding/use-brand"
import { hasAuthHintCookie } from "@/lib/frontier/session-store"
import { HealthRing } from "@/components/HealthRing"
import { AppTooltip } from "@/components/ui/tooltip"
import { MultimodalWorkspace } from "./MultimodalWorkspace"
import { LanguageBlitz, LanguageMarquee } from "./LanguageBlitz"
import { BetaBar } from "./BetaBar"
import { useMarketingShell } from "./useMarketingShell"
import "./homepage.css"

// Help/documentation site (help.aquilla.app). Configurable at build time with
// the same default HelpMenu uses, so the marketing front door and the in-app
// help affordance always point at the same docs. (AQU-702)
const DOCS_URL =
  (import.meta.env.VITE_DOCS_URL as string | undefined)?.trim() ||
  "https://help.aquilla.app"

export function Homepage() {
  const brand = useBrand()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [scrolled, setScrolled] = useState(false)
  const { theme, toggleTheme } = useMarketingShell()

  // Reveal-on-scroll + nav elevation.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })

    const els = rootRef.current?.querySelectorAll<HTMLElement>(".aq-reveal") ?? []
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target) } }),
      { threshold: 0.16, rootMargin: "0px 0px -8% 0px" },
    )
    els.forEach((el) => io.observe(el))
    return () => { window.removeEventListener("scroll", onScroll); io.disconnect() }
  }, [])

  const Mark = brand.logo.Mark

  // Signed-in visitors (aq_hint=1 cookie — same bit the Worker reads at the
  // edge) go straight into the app at `/`; returning (unsigned-in) users go to
  // /login; brand-new visitors use the "Sign up free" button → /onboarding.
  // AQU-282: "Open app" is the sign-in entry for returning users — it must
  // NOT send them through the signup wizard.
  const appHref = hasAuthHintCookie() ? "/" : "/login"

  return (
    <div className="aq-root" ref={rootRef} data-theme={theme}>
      <div className="aq-atmosphere" aria-hidden="true">
        <div className="aq-glow aq-glow-dawn" />
        <div className="aq-glow aq-glow-blue" />
        <div className="aq-grain" />
      </div>

      {/* ── Beta strip (above the sticky nav; scrolls away) ──────────────── */}
      <BetaBar />

      {/* ── Nav ───────────────────────────────────────────────────────── */}
      <nav className="aq-nav" data-scrolled={scrolled}>
        <div className="aq-container aq-nav-inner">
          <a href="#top" className="aq-brand">
            <Mark className="aq-brand-mark" />
            <span className="aq-brand-name">{brand.app.name}</span>
          </a>
          <div className="aq-nav-links">
            <a className="aq-nav-link" href="#workspace">Workspace</a>
            <a className="aq-nav-link" href="#multimodal">Multimodal</a>
            <a className="aq-nav-link" href="#languages">Languages</a>
            <a className="aq-nav-link" href="#quality">Quality</a>
            <a className="aq-nav-link" href="#pricing">Pricing</a>
            <a className="aq-nav-link" href={DOCS_URL}>Docs</a>
          </div>
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
            <a href={appHref} className="aq-btn aq-btn-ghost aq-btn-sm">Open app</a>
            <a href="/onboarding" className="aq-btn aq-btn-gold aq-btn-sm">Sign up free</a>
          </div>
        </div>
      </nav>

      <main className="aq-shell" id="top" aria-label="Homepage content">
        {/* ── Hero ────────────────────────────────────────────────────── */}
        <section className="aq-container aq-hero">
          <div className="aq-hero-eyebrow aq-load aq-d1">
            <span className="aq-dot" aria-hidden="true" /> One workspace for text, audio &amp; video translation
          </div>
          <h1 className="aq-display aq-load aq-d2">
            Translators, <span className="aq-gold-text aq-display-italic">lifted.</span>
          </h1>
          <p className="aq-hero-sub aq-load aq-d3">
            The first workspace where <b style={{ color: "var(--aq-text)" }}>text and audio</b> translation
            live under one roof — with caption and subtitle translation for video coming soon. Real-time guidance and a memory
            that learns — so every language reaches every medium it's heard, read, and watched in.
          </p>
          <div className="aq-hero-actions aq-load aq-d4">
            <a href="/onboarding" className="aq-btn aq-btn-gold aq-btn-lg">Sign up free</a>
            <a href="#workspace" className="aq-btn aq-btn-ghost aq-btn-lg">See how it works <IconArrow /></a>
          </div>
          <div className="aq-hero-trust aq-load aq-d5">
            <span><b>Free for everyone</b></span><span style={{ opacity: 0.4 }}>·</span>
            <span><b>Enterprise support</b>, just reach out</span>
          </div>
        </section>

        {/* ── Centerpiece ─────────────────────────────────────────────── */}
        <section className="aq-container aq-load aq-d6" id="workspace" style={{ paddingBottom: "clamp(40px,7vh,90px)" }}>
          {/* The workspace mock renders a <Waveform> that touches canvas/audio-DSP
              APIs and throws in headless/preview renderers. A local boundary keeps
              that failure from unmounting the whole marketing page — it degrades to
              nothing while hero, nav, and the rest of the page render normally. */}
          <WorkspaceBoundary>
            <MultimodalWorkspace theme={theme} />
          </WorkspaceBoundary>
        </section>

        {/* ── Trust band ──────────────────────────────────────────────── */}
        <section className="aq-container" style={{ paddingBottom: 24 }}>
          <div className="aq-reveal" style={{ textAlign: "center" }}>
            <p style={{ fontSize: 13, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--aq-faint)" }}>
              Proven in some of the highest-stakes, lowest-resource translation there is
            </p>
            <div style={{ display: "flex", gap: 32, justifyContent: "center", flexWrap: "wrap", marginTop: 20, color: "var(--aq-dim)", fontWeight: 540, fontSize: 17 }}>
              <span>Come&nbsp;and&nbsp;See</span>
              <span style={{ opacity: 0.3 }}>·</span>
              <span>125 languages, 2× Guinness World Record</span>
            </div>
          </div>
        </section>

        {/* ── Multimodal manifesto ────────────────────────────────────── */}
        <section className="aq-container aq-section aq-manifesto" id="multimodal">
          <div className="aq-head aq-center aq-reveal">
            <span className="aq-eyebrow">The future is multimodal</span>
            <h2 className="aq-display">Most of the world meets language by listening, not reading.</h2>
            <p>
              For too long, tools forced a choice between the written word and the spoken one. Aquilla refuses it.
              Translate text and audio today, with captions and subtitles for video coming soon — all drafted against one source,
              held to one project's voice, kept in sync as it grows.
            </p>
          </div>
          <div className="aq-modal-row aq-reveal">
            {[
              { i: <IconText2 />, t: "Text" },
              { i: <IconWave2 />, t: "Audio" },
              { i: <IconFilm2 />, t: "Video", soon: true },
              { i: <IconPic2 />, t: "Images", soon: true },
              { i: <IconBook2 />, t: "Oral stories", soon: true },
            ].map((m) => (
              m.soon ? (
                <AppTooltip key={m.t} content="Coming soon">
                  <span className="aq-modal-tag" style={{ opacity: 0.55 }}>
                    {m.i}{m.t}<span style={{ fontSize: "10px", marginLeft: 4, opacity: 0.7, verticalAlign: "super" }}>soon</span>
                  </span>
                </AppTooltip>
              ) : (
                <span className="aq-modal-tag" key={m.t}>
                  {m.i}{m.t}
                </span>
              )
            ))}
          </div>
        </section>

        {/* ── Language blitz: low-resource AI ─────────────────────────── */}
        <section className="aq-container aq-section" id="languages">
          <div className="aq-head aq-center aq-reveal">
            <span className="aq-eyebrow">Low-resource? Still in reach.</span>
            <h2 className="aq-display">Trusted translations — even in languages most tools have never seen.</h2>
            <p>
              Aquilla brings real AI assistance to the long tail: the thousands of languages with little data and,
              often, a single translator. Here is the UDHR's opening line across the world's tongues — the kind
              of trusted, expert-led translation now within reach for the languages still waiting.
            </p>
          </div>
          <div className="aq-reveal">
            <LanguageBlitz />
            <LanguageMarquee />
            <div className="aq-mtpe">
              <div className="aq-mtpe-side aq-mtpe-x">
                <IconX />
                <span>This isn't <b>post-editing a machine's output</b>. We don't believe the path to quality is making an expert trail behind a model that has already decided every word.</span>
              </div>
              <div className="aq-mtpe-vs" />
              <div className="aq-mtpe-side aq-mtpe-check">
                <IconCheck />
                <span>We equip the <b>subject-matter expert to steer</b>. The AI drafts and remembers; the human leads from the first word. That's how quality and confidence actually compound.</span>
              </div>
            </div>
          </div>
        </section>

        {/* ── Feature: Living Memory ──────────────────────────────────── */}
        <section className="aq-container aq-section">
          <div className="aq-feature">
            <div className="aq-feature-copy aq-reveal">
              <span className="aq-eyebrow">Living Memory</span>
              <h3 className="aq-display" style={{ marginTop: 14 }}>Fix it once. The system learns.</h3>
              <p>
                Post-editing AI output is just the old waterfall with a faster first draft — you still fix the same
                mistake in every chapter, forever. In Aquilla, a correction becomes guidance. The next draft already
                knows your team's terms, your register, your decisions.
              </p>
              <ul className="aq-feature-list">
                <li><IconCheck /> Remembers contextual decisions — not a static TM that faithfully preserves old mistakes</li>
                <li><IconCheck /> Real-time checks and back-translation as you work</li>
                <li><IconCheck /> Many translators, one consistent project</li>
              </ul>
            </div>
            <div className="aq-demo-card aq-reveal">
              <div style={{ fontSize: 12.5, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--aq-faint)", marginBottom: 14 }}>Doc 4.2 · draft</div>
              <p style={{ fontSize: 17, lineHeight: 1.6, color: "var(--aq-text)" }}>
                …y allí desperdició sus{" "}
                <AppTooltip content="Living Memory: this project renders 'goods' as 'bienes'">
                  <span className="violation-blot violation-blot-minor">bienestar</span>
                </AppTooltip>{" "}
                viviendo perdidamente.
              </p>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
                <span className="aq-chip"><span className="aq-strike">bienestar</span></span>
                <IconArrow />
                <span className="aq-chip aq-chip-gold"><IconSparkS /> bienes</span>
              </div>
              <div style={{ marginTop: 18, padding: "12px 14px", borderRadius: 12, border: "1px solid var(--aq-line)", background: "var(--aq-accent-wash)", display: "flex", gap: 11, alignItems: "flex-start" }}>
                <IconMemory />
                <span style={{ fontSize: 13.5, color: "var(--aq-dim)", lineHeight: 1.5 }}>
                  Saved as a contextual decision — not a find-and-replace. Aquilla carries <b style={{ color: "var(--aq-gold-soft)" }}>bienes</b> into the passages where the meaning calls for it, and leaves it where it doesn't.
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* ── Feature: Quality you can see ────────────────────────────── */}
        <section className="aq-container aq-section" id="quality">
          <div className="aq-feature aq-rev">
            <div className="aq-feature-copy aq-reveal">
              <span className="aq-eyebrow">Evidence, not a quality certificate</span>
              <h3 className="aq-display" style={{ marginTop: 14 }}>Review support you can inspect.</h3>
              <p>
                Every cell carries a retrieval-support signal showing how it connects to approved, trusted work around it.
                The signal helps reviewers prioritize terminology and context checks; it never replaces expert review.
              </p>
              <ul className="aq-feature-list">
                <li><IconCheck /> Explainable support evidence for every cell — text <em>and</em> audio</li>
                <li><IconCheck /> Lower-support work surfaced for closer review</li>
                <li><IconCheck /> Works whether one expert is steering or a whole team is — no fixed review pipeline</li>
              </ul>
            </div>
            <div className="aq-demo-card aq-reveal">
              <div className="aq-health-grid">
                {[
                  { l: "Doc 3", s: "fully validated", h: 96 },
                  { l: "Doc 5.2", s: "needs a look", h: 58 },
                  { l: "Doc 1", s: "in progress", h: 81 },
                  { l: "Doc 4", s: "drafting", h: 34 },
                ].map((c) => (
                  <div className="aq-health-item" key={c.l}>
                    <HealthRing health={c.h} size={34} strokeWidth={3.5} />
                    <div>
                      <div className="aq-hi-label">{c.l}</div>
                      <div className="aq-hi-sub">{c.s}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 16, padding: "13px 15px", borderRadius: 12, border: "1px solid var(--aq-line)", background: "var(--aq-fill)" }}>
                <div style={{ fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--aq-faint)", marginBottom: 10 }}>Biggest drags</div>
                {[
                  { ref: "Doc 4.6", h: 34 },
                  { ref: "Doc 5.2 · 5", h: 52 },
                ].map((d) => (
                  <div key={d.ref} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", fontSize: 13.5, color: "var(--aq-dim)" }}>
                    <HealthRing health={d.h} size={15} strokeWidth={2.2} />
                    <span className="aq-mono">{d.ref}</span>
                    <span style={{ marginLeft: "auto", color: "var(--aq-faint)" }}>jump →</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── Phased vs steering: continuous flow ─────────────────────── */}
        <section className="aq-container aq-section" id="steering">
          <div className="aq-head aq-center aq-reveal">
            <span className="aq-eyebrow">Coordination compression</span>
            <h2 className="aq-display">Drafting and checking aren't phases. They're one loop.</h2>
            <p>
              The hidden cost in translation isn't drafting — it's the waiting between steps: the handoffs, queues, and
              "waiting for review" states between every phase. Aquilla collapses them into one continuous flow, where
              every pass compounds quality instead of waiting on the next.
            </p>
          </div>
          <div className="aq-flow aq-reveal">
            <div className="aq-flow-col aq-flow-phased">
              <div className="aq-flow-label">Phased · assembly line</div>
              <div className="aq-flow-stack">
                <div className="aq-flow-box">Drafting</div>
                <div className="aq-flow-gap"><span><i className="aq-flow-spin" aria-hidden="true" />handoff · wait</span></div>
                <div className="aq-flow-box">Self-checking</div>
                <div className="aq-flow-gap"><span><i className="aq-flow-spin" aria-hidden="true" />handoff · wait</span></div>
                <div className="aq-flow-box">Team checking</div>
                <div className="aq-flow-gap"><span><i className="aq-flow-spin" aria-hidden="true" />handoff · wait</span></div>
                <div className="aq-flow-box">Consultant checking</div>
                <div className="aq-flow-gap"><span><i className="aq-flow-spin" aria-hidden="true" />handoff · wait</span></div>
                <div className="aq-flow-box">Publishing</div>
              </div>
              <div className="aq-flow-note">Quality is inspected at the end. Every bottleneck is a queue.</div>
            </div>

            <div className="aq-flow-vs">vs</div>

            <div className="aq-flow-col">
              <div className="aq-flow-label aq-flow-label-on">Steering</div>
              <div className="aq-loop">
                <div className="aq-loop-pair">
                  <div className="aq-flow-box">Drafting</div>
                  <span className="aq-loop-cyc"><IconCycle /></span>
                  <div className="aq-flow-box">Checking</div>
                  <span className="aq-loop-toast" aria-hidden="true">
                    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="var(--aq-green)" strokeWidth="2.2"><path d="M3 8.5l3 3 7-7.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    checked
                  </span>
                </div>
                <div className="aq-loop-down"><IconUpDown /></div>
                <div className="aq-flow-box aq-flow-publish">Publishing &amp; feedback</div>
              </div>
              <div className="aq-flow-note">Quality is built in. Feedback flows straight back into the loop.</div>
            </div>
          </div>

          <div
            className="aq-reveal"
            style={{
              textAlign: "center",
              marginTop: "clamp(44px,7vw,80px)",
              maxWidth: "min(600px, 85vw)",
              marginInline: "auto"
            }}
          >
            <IconQuote />
            <p
              className="aq-display"
              style={{
                fontSize: "clamp(22px,3.2vw,38px)",
                lineHeight: 1.25,
                marginTop: 14,
                maxWidth: "100%"
              }}
            >
              Pilots don't fly for six hours, then ask someone to check the route. They steer, constantly.
              <span className="aq-gold-text"> Translation should too.</span>
            </p>
          </div>
     
        </section>

        {/* ── Proof / stats ───────────────────────────────────────────── */}
        <section className="aq-container aq-section">
          <div className="aq-feature" style={{ alignItems: "start" }}>
            <div className="aq-feature-copy aq-reveal">
              <span className="aq-eyebrow">Come and See Foundation</span>
              <h3 className="aq-display" style={{ marginTop: 14 }}>125 languages. A Guinness World Record. Twice.</h3>
              <p>
                Come and See is translating <em>The Chosen</em> into 600 languages to reach 95% of the world.
                With experts steering and the system carrying consistency and in-flow review, they reached
                125 languages — including 39 low-resource languages a subject-matter expert could finally
                carry — reaching communities that would otherwise still be waiting for a team to free up.
              </p>
              <blockquote className="aq-quote aq-display" style={{ marginTop: 26, color: "var(--aq-text)" }}>
                125 languages reached. Two Guinness World Records. One workspace.
              </blockquote>
              <a href="/case-studies/come-and-see" className="aq-btn aq-btn-ghost aq-btn-sm" style={{ marginTop: 24 }}>
                Read the full story <IconArrow />
              </a>
            </div>
            <div className="aq-reveal" style={{ alignSelf: "center" }}>
              <div className="aq-stats" style={{ gridTemplateColumns: "1fr" }}>
                {/* Stats from the Come and See case study (codexeditor.app/case-studies/come-and-see). Verify current before launch. */}
                <div className="aq-stat">
                  <div className="aq-stat-num aq-display aq-gold-text">125</div>
                  <div className="aq-stat-label">languages for Season 1 of The Chosen — reaching the languages people actually speak</div>
                </div>
                <div className="aq-stat">
                  <div className="aq-stat-num aq-display aq-gold-text">2×</div>
                  <div className="aq-stat-label">back-to-back Guinness World Records for the most translated streaming season</div>
                </div>
                <div className="aq-stat">
                  <div className="aq-stat-num aq-display aq-gold-text">240</div>
                  <div className="aq-stat-label">more translations already in the pipeline</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Proof / Biblica ─────────────────────────────────────────── */}
        <section className="aq-container aq-section" style={{ paddingTop: 0 }}>
          <div className="aq-feature" style={{ alignItems: "start" }}>
            <div className="aq-feature-copy aq-reveal">
              <span className="aq-eyebrow">Biblica Global Publishing</span>
              <h3 className="aq-display" style={{ marginTop: 14 }}>A 130-year publisher, now AI-first.</h3>
              <p>
                Biblica&apos;s Global Publishing team moved almost its entire resource-translation workflow
                onto Aquilla — with the expert leading every step. They updated full Spanish and Portuguese
                Bibles in twelve months, and took a Study Bible straight to a typeset, print-ready PDF.
              </p>
              <blockquote className="aq-quote aq-display" style={{ marginTop: 26, color: "var(--aq-text)" }}>
                Being able to end up with a print-ready document — that&apos;s game-changing.
              </blockquote>
              <a href="/case-studies/biblica" className="aq-btn aq-btn-ghost aq-btn-sm" style={{ marginTop: 24 }}>
                Read the full story <IconArrow />
              </a>
            </div>
            <div className="aq-reveal" style={{ alignSelf: "center" }}>
              <div className="aq-stats" style={{ gridTemplateColumns: "1fr" }}>
                {/* Stats from the Biblica case study / Noeline's write-up. Verify current before launch. */}
                <div className="aq-stat">
                  <div className="aq-stat-num aq-display aq-gold-text">2</div>
                  <div className="aq-stat-label">full Bibles — Spanish &amp; Portuguese — updated in twelve months</div>
                </div>
                <div className="aq-stat">
                  <div className="aq-stat-num aq-display aq-gold-text">130 yrs</div>
                  <div className="aq-stat-label">of traditional publishing experience, now working AI-first</div>
                </div>
                <div className="aq-stat">
                  <div className="aq-stat-num aq-display aq-gold-text">Print-ready</div>
                  <div className="aq-stat-label">a Study Bible taken straight to a typeset PDF — not just a draft</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Pricing ─────────────────────────────────────────────────── */}
        <section className="aq-container aq-section" id="pricing">
          <div className="aq-head aq-center aq-reveal" style={{ marginBottom: 44 }}>
            <span className="aq-eyebrow">Access</span>
            <h2 className="aq-display">Free to start. Simple when you scale.</h2>
            <p>Aquilla is free for everyone today. No payment is collected on this site yet — usage-based pricing is coming, and we'll tell you before anything changes.</p>
          </div>
          <div className="aq-price-grid aq-reveal" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
            <div className="aq-price">
              <h4 className="aq-display">Everyone</h4>
              <div className="aq-price-tag">Free, forever</div>
              <p>The whole workspace — no credit card, no trial clock. For every translator and team.</p>
              <ul>
                <li><IconCheck /> Full workspace — text and audio translation</li>
                <li><IconCheck /> Real-time guidance &amp; back-translation</li>
                <li><IconCheck /> Cloud sync &amp; team collaboration</li>
                <li><IconCheck /> On-device speech</li>
              </ul>
              <a href="/onboarding" className="aq-btn aq-btn-gold">Sign up free</a>
            </div>
            <div className="aq-price">
              <span className="aq-chip" style={{ position: "absolute", top: 20, right: 20 }}>Coming soon</span>
              <h4 className="aq-display">Pro</h4>
              <div className="aq-price-tag">Per project / month</div>
              <p>For elevated AI usage beyond the free cap. Pay-as-you-go for usage over that — not live yet, and nothing is billed today.</p>
              <ul>
                <li><IconCheck /> Everything in Everyone</li>
                <li><IconCheck /> Higher AI usage caps per project</li>
                <li><IconCheck /> Pay-as-you-go for usage above the cap</li>
              </ul>
              <a href="mailto:hello@aquilla.app?subject=Pro%20waitlist" className="aq-btn aq-btn-ghost">Join the waitlist</a>
            </div>
            <div className="aq-price" data-feature="true">
              <h4 className="aq-display">Enterprise support</h4>
              <div className="aq-price-tag">Talk to us</div>
              <p>Running translation at scale or need dedicated help? We're happy to support you directly.</p>
              <ul>
                <li><IconCheck /> Dedicated onboarding &amp; direct support</li>
                <li><IconCheck /> Coordination across large programs</li>
                <li><IconCheck /> We want to see you succeed</li>
              </ul>
              <a href="mailto:hello@aquilla.app" className="aq-btn aq-btn-ghost">Talk to us</a>
            </div>
          </div>
        </section>

        {/* ── Final CTA ───────────────────────────────────────────────── */}
        <section className="aq-container aq-section" style={{ paddingTop: 0 }}>
          <div className="aq-cta-band aq-reveal">
            <h2 className="aq-display" aria-label="Get started — Translators, lifted.">Translators, <span className="aq-gold-text aq-display-italic">lifted.</span></h2>
            <p>Open your source text, draft in any medium, and let the system steer alongside you. Start today — it's free.</p>
            <div className="aq-cta-actions">
              <a href="/onboarding" className="aq-btn aq-btn-gold aq-btn-lg">Sign up free</a>
              <a href="#workspace" className="aq-btn aq-btn-ghost aq-btn-lg">See the workspace</a>
            </div>
          </div>
        </section>
      </main>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <footer className="aq-footer">
        <div className="aq-container">
          <div className="aq-footer-inner">
            <div className="aq-footer-brand">
              <a className="aq-brand" href="#top"><Mark className="aq-brand-mark" /><span className="aq-brand-name">{brand.app.name}</span></a>
              <p>{brand.app.tagline} A multimodal translation workspace for every language still waiting.</p>
            </div>
            <div className="aq-footer-cols">
              <div className="aq-footer-col">
                <h5>Product</h5>
                <a href="#workspace">Workspace</a>
                <a href="#multimodal">Multimodal</a>
                <a href="#quality">Quality</a>
                <a href="#pricing">Pricing</a>
                <a href="/case-studies/come-and-see">Come and See</a>
                <a href="/case-studies/biblica">Biblica</a>
              </div>
              <div className="aq-footer-col">
                <h5>Get started</h5>
                <a href={appHref}>Open app</a>
                <a href="/onboarding">Sign up free</a>
                <a href="#pricing">Enterprise</a>
              </div>
              <div className="aq-footer-col">
                <h5>Resources</h5>
                <a href={DOCS_URL}>Help &amp; docs</a>
                <a href="mailto:hello@aquilla.app">Contact us</a>
              </div>
            </div>
          </div>
          <div className="aq-footer-base">
            <span>© {new Date().getFullYear()} {brand.app.name} · {brand.deploy?.domain ?? "aquilla.app"}</span>
          </div>
        </div>
      </footer>
    </div>
  )
}

/* ── Workspace error boundary ───────────────────────────────────────────────
 * Scoped boundary for the homepage centerpiece. If <MultimodalWorkspace> (or its
 * <Waveform>) throws during render — e.g. canvas/audio-DSP APIs unavailable in a
 * headless/preview browser — this catches it and renders nothing, so the failure
 * degrades the centerpiece alone instead of unmounting the entire marketing page.
 */
class WorkspaceBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  render() { return this.state.hasError ? null : this.props.children }
}

/* ── Icons ──────────────────────────────────────────────────────────────── */
function IconArrow() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" /></svg> }
function IconCheck() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 8.5l3 3 7-7.5" strokeLinecap="round" strokeLinejoin="round" /></svg> }
function IconX() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" /></svg> }
function IconSun() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="9" cy="9" r="3.6" /><path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M14.3 3.7l-1.4 1.4M5.1 12.9l-1.4 1.4" strokeLinecap="round" /></svg> }
function IconMoon() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M15 10.5A6.5 6.5 0 0 1 7.5 3a6.5 6.5 0 1 0 7.5 7.5z" strokeLinejoin="round" /></svg> }
function IconCycle() { return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></svg> }
function IconUpDown() { return <svg aria-hidden="true" viewBox="0 0 16 20" width="16" height="20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M5 6V3m0 0L3 5m2-2l2 2" strokeLinecap="round" strokeLinejoin="round" /><path d="M11 14v3m0 0l2-2m-2 2l-2-2" strokeLinecap="round" strokeLinejoin="round" /><path d="M5 6v8M11 14V6" strokeLinecap="round" /></svg> }
function IconSparkS() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 1l1.3 3.9L13 6 9.3 7.4 8 11 6.7 7.4 3 6l3.7-1.1z" /></svg> }
function IconMemory() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="var(--aq-gold)" strokeWidth="1.4" style={{ flexShrink: 0, marginTop: 1 }}><path d="M8 2.5a3 3 0 0 1 3 3v.3a2.4 2.4 0 0 1-.4 4.5A2.6 2.6 0 0 1 8 13a2.6 2.6 0 0 1-2.6-2.7A2.4 2.4 0 0 1 5 5.8v-.3a3 3 0 0 1 3-3z" /></svg> }
function IconQuote() { return <svg aria-hidden="true" viewBox="0 0 32 24" width="40" height="30" fill="var(--aq-gold)" opacity="0.5" style={{ marginInline: "auto", display: "block" }}><path d="M13 24c-4 0-7-3-7-7 0-6 5-11 11-13l1 3c-3 1-6 4-6 7 4 0 6 2 6 5s-2 5-6 5zm15 0c-4 0-7-3-7-7 0-6 5-11 11-13l1 3c-3 1-6 4-6 7 4 0 6 2 6 5s-2 5-6 5z" /></svg> }
function IconText2() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 5h10M4 9h10M4 13h6" strokeLinecap="round" /></svg> }
function IconWave2() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 9h0M5.5 5v8M9 2.5v13M12.5 6v6M16 9h0" strokeLinecap="round" /></svg> }
function IconFilm2() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2.5" y="4.5" width="13" height="9" rx="1.5" /><path d="M8 7.5l3.5 1.5L8 10.5z" fill="currentColor" stroke="none" /></svg> }
function IconPic2() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3.5" width="12" height="11" rx="1.5" /><circle cx="7" cy="7.5" r="1.3" /><path d="M4 12l3.5-3.5 2.5 2L13 8l2 2" /></svg> }
function IconBook2() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 4C7.3 3 4.5 3 3 3.7v10c1.5-.7 4.3-.7 6 .3M9 4c1.7-1 4.5-1 6-.3v10c-1.5-.7-4.3-.7-6 .3z" /></svg> }
