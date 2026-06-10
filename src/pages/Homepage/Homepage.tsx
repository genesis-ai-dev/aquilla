import { useEffect, useRef, useState } from "react"
import { useBrand } from "@/branding/use-brand"
import { hasAuthHintCookie } from "@/lib/frontier/session-store"
import { HealthRing } from "@/components/HealthRing"
import { MultimodalWorkspace } from "./MultimodalWorkspace"
import { LanguageBlitz, LanguageMarquee } from "./LanguageBlitz"
import "./homepage.css"

/** Saved choice wins; otherwise follow the OS color scheme; else dark. */
function readInitialTheme(): "light" | "dark" {
  try {
    const saved = sessionStorage.getItem("aq-home-theme")
    if (saved === "light" || saved === "dark") return saved
  } catch { /* no storage */ }
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  } catch { return "dark" }
}

export function Homepage() {
  const brand = useBrand()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [scrolled, setScrolled] = useState(false)
  const [theme, setTheme] = useState<"light" | "dark">(readInitialTheme)
  const toggleTheme = () =>
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark"
      try { sessionStorage.setItem("aq-home-theme", next) } catch { /* no storage */ }
      return next
    })

  // Follow the OS theme while the visitor hasn't explicitly toggled. Once they
  // pick a theme (saved in sessionStorage) their choice wins and system changes
  // are ignored.
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)")
    if (!mq) return
    const onChange = (e: MediaQueryListEvent) => {
      try {
        const saved = sessionStorage.getItem("aq-home-theme")
        if (saved === "light" || saved === "dark") return
      } catch { /* no storage */ }
      setTheme(e.matches ? "dark" : "light")
    }
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  // Load the Fraunces display face only while this page is mounted.
  useEffect(() => {
    const id = "aq-fonts"
    if (!document.getElementById(id)) {
      const pre1 = document.createElement("link")
      pre1.rel = "preconnect"; pre1.href = "https://fonts.googleapis.com"
      const pre2 = document.createElement("link")
      pre2.rel = "preconnect"; pre2.href = "https://fonts.gstatic.com"; pre2.crossOrigin = "anonymous"
      const link = document.createElement("link")
      link.id = id
      link.rel = "stylesheet"
      link.href =
        "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..620;1,9..144,300..560&display=swap"
      // Noto faces for the less-common scripts in the language reel (Coptic,
      // Geʻez, Tibetan) so they render instead of falling back to tofu boxes.
      const noto = document.createElement("link")
      noto.rel = "stylesheet"
      noto.href =
        "https://fonts.googleapis.com/css2?family=Noto+Sans+Coptic&family=Noto+Serif+Ethiopic:wght@400..600&family=Noto+Serif+Tibetan:wght@400..600&display=swap"
      document.head.append(pre1, pre2, link, noto)
    }
  }, [])

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
  // /login; brand-new visitors use the "Start free" button → /onboarding.
  // FRO-282: "Open app" is the sign-in entry for returning users — it must
  // NOT send them through the signup wizard.
  const appHref = hasAuthHintCookie() ? "/" : "/login"

  return (
    <div className="aq-root" ref={rootRef} data-theme={theme}>
      <div className="aq-atmosphere" aria-hidden="true">
        <div className="aq-glow aq-glow-dawn" />
        <div className="aq-glow aq-glow-blue" />
        <div className="aq-grain" />
      </div>

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
          </div>
          <div className="aq-nav-cta">
            <button
              type="button"
              className="aq-theme-toggle"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              title={theme === "dark" ? "Light mode" : "Dark mode"}
            >
              {theme === "dark" ? <IconSun /> : <IconMoon />}
            </button>
            <a href={appHref} className="aq-btn aq-btn-ghost aq-btn-sm">Open app</a>
            <a href="/onboarding" className="aq-btn aq-btn-gold aq-btn-sm">Start free</a>
          </div>
        </div>
      </nav>

      <main className="aq-shell" id="top" aria-label="Homepage content">
        {/* ── Hero ────────────────────────────────────────────────────── */}
        <section className="aq-container aq-hero">
          <div className="aq-hero-eyebrow aq-load aq-d1">
            <span className="aq-dot" aria-hidden="true" /> One workspace for Bible &amp; ministry translation
          </div>
          <h1 className="aq-display aq-load aq-d2">
            Translation, <span className="aq-gold-text aq-display-italic">lifted.</span>
          </h1>
          <p className="aq-hero-sub aq-load aq-d3">
            The first workspace where <b style={{ color: "var(--aq-text)" }}>text and audio</b> translation
            live under one roof — with caption and subtitle translation for video too. Real-time guidance and a memory
            that learns — so Scripture reaches every language, in every medium it's heard, read, and watched.
          </p>
          <div className="aq-hero-actions aq-load aq-d4">
            <a href="/onboarding" className="aq-btn aq-btn-gold aq-btn-lg">Start translating free</a>
            <a href="#workspace" className="aq-btn aq-btn-ghost aq-btn-lg">See how it works <IconArrow /></a>
          </div>
          <div className="aq-hero-trust aq-load aq-d5">
            <span><b>Free for everyone</b></span><span style={{ opacity: 0.4 }}>·</span>
            <span><b>Enterprise support</b>, just reach out</span>
          </div>
        </section>

        {/* ── Centerpiece ─────────────────────────────────────────────── */}
        <section className="aq-container aq-load aq-d6" id="workspace" style={{ paddingBottom: "clamp(40px,7vh,90px)" }}>
          <MultimodalWorkspace theme={theme} />
        </section>

        {/* ── Trust band ──────────────────────────────────────────────── */}
        <section className="aq-container" style={{ paddingBottom: 24 }}>
          <div className="aq-reveal" style={{ textAlign: "center" }}>
            <p style={{ fontSize: 13, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--aq-faint)" }}>
              Proven in the highest-stakes, lowest-resource translation on earth
            </p>
            <div style={{ display: "flex", gap: 32, justifyContent: "center", flexWrap: "wrap", marginTop: 20, color: "var(--aq-dim)", fontWeight: 540, fontSize: 17 }}>
              <span>Come&nbsp;and&nbsp;See</span>
              <span style={{ opacity: 0.3 }}>·</span>
              <span>ETEN Innovation Lab</span>
              <span style={{ opacity: 0.3 }}>·</span>
              <span>All-Access Goals 2033</span>
            </div>
          </div>
        </section>

        {/* ── Multimodal manifesto ────────────────────────────────────── */}
        <section className="aq-container aq-section aq-manifesto" id="multimodal">
          <div className="aq-head aq-center aq-reveal">
            <span className="aq-eyebrow">The future is multimodal</span>
            <h2 className="aq-display">Most of the world meets Scripture by listening, not reading.</h2>
            <p>
              For too long, tools forced a choice between the written word and the spoken one. Aquilla refuses it.
              Translate text and audio, add captions and subtitles to video — all drafted against one source,
              held to one project's voice, kept in sync as it grows.
            </p>
          </div>
          <div className="aq-modal-row aq-reveal">
            {[
              { i: <IconText2 />, t: "Text" },
              { i: <IconWave2 />, t: "Audio" },
              { i: <IconFilm2 />, t: "Video" },
              { i: <IconPic2 />, t: "Images", soon: true },
              { i: <IconBook2 />, t: "Oral stories", soon: true },
            ].map((m) => (
              <span className="aq-modal-tag" key={m.t} title={m.soon ? "Coming soon" : undefined} style={m.soon ? { opacity: 0.55 } : undefined}>
                {m.i}{m.t}{m.soon ? <span style={{ fontSize: "10px", marginLeft: 4, opacity: 0.7, verticalAlign: "super" }}>soon</span> : null}
              </span>
            ))}
          </div>
        </section>

        {/* ── Language blitz: low-resource AI ─────────────────────────── */}
        <section className="aq-container aq-section" id="languages">
          <div className="aq-head aq-center aq-reveal">
            <span className="aq-eyebrow">Low-resource? Still in reach.</span>
            <h2 className="aq-display">A first draft in seconds — even in languages most tools have never seen.</h2>
            <p>
              Aquilla brings real AI assistance to the long tail: the thousands of languages with little data and,
              often, a single translator. But a draft is a starting point, not a verdict. Here is John 3:16 across
              the world's tongues — the kind of head start now within reach for the languages still waiting.
            </p>
          </div>
          <div className="aq-reveal">
            <LanguageBlitz />
            <LanguageMarquee />
            <div className="aq-mtpe">
              <div className="aq-mtpe-side aq-mtpe-x">
                <IconX />
                <span>This isn't <b>machine-translation post-editing</b>. We don't believe the path to quality is making an expert trail behind a model that has already decided every word.</span>
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
              <div style={{ fontSize: 12.5, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--aq-faint)", marginBottom: 14 }}>Luke 15:13 · draft</div>
              <p style={{ fontSize: 17, lineHeight: 1.6, color: "var(--aq-text)" }}>
                …y allí desperdició sus{" "}
                <span className="violation-blot violation-blot-minor" title="Living Memory: this project renders 'goods' as 'bienes'">bienestar</span>{" "}
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
              <span className="aq-eyebrow">Confidence, not guesswork</span>
              <h3 className="aq-display" style={{ marginTop: 14 }}>Quality you can see at a glance.</h3>
              <p>
                Every cell carries a confidence score that reflects how well it lines up with validated, trusted work
                around it. The system surfaces what needs a human's attention — so one expert can steer a whole project
                instead of re-reading it.
              </p>
              <ul className="aq-feature-list">
                <li><IconCheck /> Confidence derived on read — text <em>and</em> audio</li>
                <li><IconCheck /> The biggest drags, ranked and one click away</li>
                <li><IconCheck /> Built for a single subject-matter expert with no fixed review pipeline</li>
              </ul>
            </div>
            <div className="aq-demo-card aq-reveal">
              <div className="aq-health-grid">
                {[
                  { l: "John 3", s: "fully validated", h: 96 },
                  { l: "Psalm 96", s: "needs a look", h: 58 },
                  { l: "Genesis 1", s: "in progress", h: 81 },
                  { l: "Luke 15", s: "drafting", h: 34 },
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
                  { ref: "Luke 15:30", h: 34 },
                  { ref: "Psalm 96:5", h: 52 },
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
              The hidden cost in translation isn't drafting — it's coordination latency: the handoffs, queues, and
              "waiting for review" states between every phase. Aquilla collapses them into one continuous flow, where
              every pass compounds quality instead of waiting on the next.
            </p>
          </div>
          <div className="aq-flow aq-reveal">
            <div className="aq-flow-col aq-flow-phased">
              <div className="aq-flow-label">Phased · assembly line</div>
              <div className="aq-flow-stack">
                <div className="aq-flow-box">Drafting</div>
                <div className="aq-flow-gap"><span>handoff · wait</span></div>
                <div className="aq-flow-box">Self-checking</div>
                <div className="aq-flow-gap"><span>handoff · wait</span></div>
                <div className="aq-flow-box">Team checking</div>
                <div className="aq-flow-gap"><span>handoff · wait</span></div>
                <div className="aq-flow-box">Consultant checking</div>
                <div className="aq-flow-gap"><span>handoff · wait</span></div>
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
                </div>
                <div className="aq-loop-down"><IconUpDown /></div>
                <div className="aq-flow-box aq-flow-publish">Publishing &amp; feedback</div>
              </div>
              <div className="aq-flow-note">Quality is built in. Feedback flows straight back into the loop.</div>
            </div>
          </div>

          <div className="aq-reveal" style={{ textAlign: "center", marginTop: "clamp(44px,7vw,80px)", maxWidth: "27ch", marginInline: "auto" }}>
            <IconQuote />
            <p className="aq-display" style={{ fontSize: "clamp(24px,3.4vw,38px)", lineHeight: 1.25, marginTop: 14 }}>
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
              <h3 className="aq-display" style={{ marginTop: 14 }}>The wall came after 86 languages. Then the work kept going.</h3>
              <p>
                Traditional team models stalled at 86. With Aquilla carrying consistency and in-flow review,
                the same effort reached 125 — adding low-resource languages where a single expert often steered the work alone.
              </p>
              <blockquote className="aq-quote aq-display" style={{ marginTop: 26, color: "var(--aq-text)" }}>
                People need to hear the story of Jesus in their own language — the language they speak, dream, and pray in.
              </blockquote>
              <div className="aq-quote-cite"><b>James Barnett</b> · CEO, Come and See</div>
            </div>
            <div className="aq-reveal" style={{ alignSelf: "center" }}>
              <div className="aq-stats" style={{ gridTemplateColumns: "1fr" }}>
                {/* SWARM-TODO(homepage-copy): Stats (125 languages, 39 low-resource, 4–16×) — verify these are current and sourced before launch */}
                <div className="aq-stat">
                  <div className="aq-stat-num aq-display aq-gold-text">125</div>
                  <div className="aq-stat-label">languages in 5 months — up from a ceiling of 86</div>
                </div>
                <div className="aq-stat">
                  <div className="aq-stat-num aq-display aq-gold-text">39</div>
                  <div className="aq-stat-label">new low-resource languages, many with a single subject-matter expert</div>
                </div>
                <div className="aq-stat">
                  <div className="aq-stat-num aq-display aq-gold-text">4–16×</div>
                  <div className="aq-stat-label">faster than typical project timelines (ETEN Innovation Lab)</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Pricing ─────────────────────────────────────────────────── */}
        <section className="aq-container aq-section" id="pricing">
          <div className="aq-head aq-center aq-reveal" style={{ marginBottom: 44 }}>
            <span className="aq-eyebrow">Access</span>
            <h2 className="aq-display">Free — because the mission comes first.</h2>
            <p>Aquilla is free for everyone. Our mission is to accelerate Bible translation, not to bill you for it.</p>
          </div>
          <div className="aq-price-grid aq-reveal">
            <div className="aq-price">
              <h4 className="aq-display">Everyone</h4>
              <div className="aq-price-tag">Free, forever</div>
              <p>The whole workspace — no credit card, no trial clock. For every translator, church, and team.</p>
              <ul>
                <li><IconCheck /> Full workspace — text and audio translation</li>
                <li><IconCheck /> Real-time guidance &amp; back-translation</li>
                <li><IconCheck /> Cloud sync &amp; team collaboration</li>
                <li><IconCheck /> On-device speech</li>
              </ul>
              <a href="/onboarding" className="aq-btn aq-btn-gold">Start free</a>
            </div>
            <div className="aq-price" data-feature="true">
              <span className="aq-chip aq-chip-gold" style={{ position: "absolute", top: 20, right: 20 }}><IconSparkS /> Mission, not margin</span>
              <h4 className="aq-display">Enterprise support</h4>
              <div className="aq-price-tag">We want to see your mission succeed</div>
              <p>Running translation at scale or need dedicated help? We're happy to support you directly — your mission matters. Just talk to us.</p>
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
            <h2 className="aq-display" aria-label="Get started — Translation, lifted.">Translation, <span className="aq-gold-text aq-display-italic">lifted.</span></h2>
            <p>Open your source text, draft in any medium, and let the system steer alongside you. Start today — it's free.</p>
            <div className="aq-cta-actions">
              <a href="/onboarding" className="aq-btn aq-btn-gold aq-btn-lg">Start translating free</a>
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
              <p>{brand.app.tagline} A multimodal translation workspace for the Church and the languages still waiting.</p>
            </div>
            <div className="aq-footer-cols">
              <div className="aq-footer-col">
                <h5>Product</h5>
                <a href="#workspace">Workspace</a>
                <a href="#multimodal">Multimodal</a>
                <a href="#quality">Quality</a>
                <a href="#pricing">Pricing</a>
              </div>
              <div className="aq-footer-col">
                <h5>Get started</h5>
                <a href={appHref}>Open app</a>
                <a href="/onboarding">Start free</a>
                <a href="#pricing">Enterprise</a>
              </div>
            </div>
          </div>
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
function IconX() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" /></svg> }
function IconSun() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="9" cy="9" r="3.6" /><path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M14.3 3.7l-1.4 1.4M5.1 12.9l-1.4 1.4" strokeLinecap="round" /></svg> }
function IconMoon() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M15 10.5A6.5 6.5 0 0 1 7.5 3a6.5 6.5 0 1 0 7.5 7.5z" strokeLinejoin="round" /></svg> }
function IconCycle() { return <svg aria-hidden="true" viewBox="0 0 20 16" width="22" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 6a6 4 0 0 1 12 0" strokeLinecap="round" /><path d="M16 10a6 4 0 0 1-12 0" strokeLinecap="round" /><path d="M15 3.5l1.4 2.6 2.6-1" strokeLinecap="round" strokeLinejoin="round" /><path d="M5 12.5l-1.4-2.6-2.6 1" strokeLinecap="round" strokeLinejoin="round" /></svg> }
function IconUpDown() { return <svg aria-hidden="true" viewBox="0 0 16 20" width="16" height="20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M5 6V3m0 0L3 5m2-2l2 2" strokeLinecap="round" strokeLinejoin="round" /><path d="M11 14v3m0 0l2-2m-2 2l-2-2" strokeLinecap="round" strokeLinejoin="round" /><path d="M5 6v8M11 14V6" strokeLinecap="round" /></svg> }
function IconSparkS() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 1l1.3 3.9L13 6 9.3 7.4 8 11 6.7 7.4 3 6l3.7-1.1z" /></svg> }
function IconMemory() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="var(--aq-gold)" strokeWidth="1.4" style={{ flexShrink: 0, marginTop: 1 }}><path d="M8 2.5a3 3 0 0 1 3 3v.3a2.4 2.4 0 0 1-.4 4.5A2.6 2.6 0 0 1 8 13a2.6 2.6 0 0 1-2.6-2.7A2.4 2.4 0 0 1 5 5.8v-.3a3 3 0 0 1 3-3z" /></svg> }
function IconQuote() { return <svg aria-hidden="true" viewBox="0 0 32 24" width="40" height="30" fill="var(--aq-gold)" opacity="0.5" style={{ marginInline: "auto", display: "block" }}><path d="M13 24c-4 0-7-3-7-7 0-6 5-11 11-13l1 3c-3 1-6 4-6 7 4 0 6 2 6 5s-2 5-6 5zm15 0c-4 0-7-3-7-7 0-6 5-11 11-13l1 3c-3 1-6 4-6 7 4 0 6 2 6 5s-2 5-6 5z" /></svg> }
function IconText2() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 5h10M4 9h10M4 13h6" strokeLinecap="round" /></svg> }
function IconWave2() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 9h0M5.5 5v8M9 2.5v13M12.5 6v6M16 9h0" strokeLinecap="round" /></svg> }
function IconFilm2() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2.5" y="4.5" width="13" height="9" rx="1.5" /><path d="M8 7.5l3.5 1.5L8 10.5z" fill="currentColor" stroke="none" /></svg> }
function IconPic2() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3.5" width="12" height="11" rx="1.5" /><circle cx="7" cy="7.5" r="1.3" /><path d="M4 12l3.5-3.5 2.5 2L13 8l2 2" /></svg> }
function IconBook2() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 4C7.3 3 4.5 3 3 3.7v10c1.5-.7 4.3-.7 6 .3M9 4c1.7-1 4.5-1 6-.3v10c-1.5-.7-4.3-.7-6 .3z" /></svg> }
