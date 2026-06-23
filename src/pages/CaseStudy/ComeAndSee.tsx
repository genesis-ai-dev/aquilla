import { useEffect, useRef } from "react"
import { useBrand } from "@/branding/use-brand"
import { AppTooltip } from "@/components/ui/tooltip"
import { useMarketingShell } from "../Homepage/useMarketingShell"
import "../Homepage/homepage.css"

/**
 * Come and See customer story — a standalone marketing page served at
 * /case-studies/come-and-see (its own build entry + a worker STATIC_PAGES line).
 * Reuses the homepage surface (aq-* classes + useMarketingShell), mirroring
 * BetaPage. Framing follows codexeditor.app/case-studies/come-and-see, adapted
 * for the Codex → Aquilla rebrand (desktop lessons, now on the web).
 *
 * Stats are sourced from that case study; verify they're current before launch.
 */
export function ComeAndSeeCaseStudy() {
  const brand = useBrand()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { theme, toggleTheme } = useMarketingShell()

  // Reveal-on-scroll, mirroring the homepage / beta page.
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
            <a href="/onboarding" className="aq-btn aq-btn-gold aq-btn-sm">Start free</a>
          </div>
        </div>
      </nav>

      <main className="aq-shell" id="top" aria-label="Come and See case study">
        {/* ── Hero ────────────────────────────────────────────────────── */}
        <section className="aq-container aq-hero">
          <div className="aq-hero-eyebrow aq-load aq-d1">
            <span className="aq-dot" aria-hidden="true" /> Partner story · Come and See
          </div>
          <h1 className="aq-display aq-load aq-d2">
            How they set the Guinness World Record. <span className="aq-gold-text aq-display-italic">Twice.</span>
          </h1>
          <p className="aq-hero-sub aq-load aq-d3">
            Come and See is translating <em>The Chosen</em> into 600 languages to reach 95% of the world.
            When the well-resourced languages ran out, one expert plus the system reached places where
            traditional teams can't go — and the record fell again.
          </p>
          <div className="aq-hero-actions aq-load aq-d4">
            <a href="/onboarding" className="aq-btn aq-btn-gold aq-btn-lg">Start translating free</a>
            <a href="#equation" className="aq-btn aq-btn-ghost aq-btn-lg">How it works <IconArrow /></a>
          </div>
        </section>

        {/* ── The mission ─────────────────────────────────────────────── */}
        <section className="aq-container aq-section" id="mission">
          <div className="aq-head aq-center aq-reveal">
            <span className="aq-eyebrow">The mission</span>
            <h2 className="aq-display">A billion people. In the language they pray in.</h2>
            <p>
              Come and See, a faith-based nonprofit, set out to share the story of Jesus with at least a
              billion people. Their flagship effort translates all seven seasons of <em>The Chosen</em> —
              the first multi-season series about Jesus's life — into 600 languages, reaching 95% of the
              world. The series has already reached over 280 million viewers across 175 countries.
            </p>
          </div>
          <div className="aq-reveal" style={{ maxWidth: "min(760px, 90vw)", margin: "36px auto 0" }}>
            <blockquote className="aq-quote aq-display" style={{ color: "var(--aq-text)", textAlign: "center" }}>
              People need to hear the story in the language they speak, dream, and pray in.
            </blockquote>
          </div>
        </section>

        {/* ── Record one: 86 ──────────────────────────────────────────── */}
        <section className="aq-container aq-section" style={{ paddingTop: 0 }}>
          <div className="aq-feature" style={{ alignItems: "start" }}>
            <div className="aq-feature-copy aq-reveal">
              <span className="aq-eyebrow">First record · September 2025</span>
              <h3 className="aq-display" style={{ marginTop: 14 }}>86 languages, the traditional way.</h3>
              <p>
                The first record came where the playbook works: well-resourced languages — Spanish,
                French, Portuguese, Mandarin — with linguists, theologians, and biblical scholars on hand.
                A 200-strong team ran a proven batch process: draft, review, revise, approve.
              </p>
              <ul className="aq-feature-list">
                <li><IconCheck /> Multiple translators per language</li>
                <li><IconCheck /> Dedicated reviewers and QA specialists</li>
                <li><IconCheck /> Voice actors for dubbed versions</li>
                <li><IconCheck /> Project management across every handoff</li>
              </ul>
            </div>
            <div className="aq-reveal" style={{ alignSelf: "center" }}>
              <p className="aq-quote aq-display" style={{ color: "var(--aq-text)" }}>
                When you exhaust the high-resource languages, the playbook changes. Going from 86 to 600
                means languages where finding even one qualified biblical scholar isn't a given.
              </p>
            </div>
          </div>
        </section>

        {/* ── Codex → Aquilla positioning ─────────────────────────────── */}
        <section className="aq-container aq-section" id="equation">
          <div className="aq-head aq-center aq-reveal">
            <span className="aq-eyebrow">From Codex to Aquilla</span>
            <h2 className="aq-display">One expert, fully amplified.</h2>
            <p>
              These records were set with <b>Codex</b> — our desktop translation editor. <b>Aquilla</b> is
              Codex reborn on the web: the same lean-translation engine that broke the record, now
              collaborative, cloud-native, and free to open in a browser. Every lesson and every hard-won
              fix from the desktop years moved with it.
            </p>
          </div>
          <div className="aq-beta-cards aq-reveal">
            {[
              {
                t: "The expert steers",
                d: "A linear pipeline — draft → provider → SME → reviewers → audio → dubbing — adds delay and cost at every handoff, and it falls apart where expertise is scarce. Aquilla flips it: one expert steers, and the system does the rest of the work alongside them.",
              },
              {
                t: "Living Memory",
                d: "Not a string database — the team's intent. As the expert works, Aquilla captures the project's voice, terminology, and standards, so every suggestion stays consistent with the work already trusted.",
              },
              {
                t: "Quality built in, not bolted on",
                d: "Real-time feedback replaces weeks-long review cycles. Checking happens in the same flow as drafting, so quality is embedded as the work is made — not inspected after the fact.",
              },
            ].map((c) => (
              <div className="aq-beta-card" key={c.t}>
                <IconSpark />
                <div>
                  <h3>{c.t}</h3>
                  <p>{c.d}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="aq-reveal" style={{ textAlign: "center", marginTop: 28, color: "var(--aq-faint)", fontSize: 13.5 }}>
            Desktop Codex is becoming Aquilla — same engine, now on the web, free for everyone.
          </div>
        </section>

        {/* ── Record two: 125 + stats ─────────────────────────────────── */}
        <section className="aq-container aq-section" style={{ paddingTop: 0 }}>
          <div className="aq-feature aq-rev" style={{ alignItems: "start" }}>
            <div className="aq-feature-copy aq-reveal">
              <span className="aq-eyebrow">Second record · February 2026</span>
              <h3 className="aq-display" style={{ marginTop: 14 }}>125 languages — into places teams can't reach.</h3>
              <p>
                At ChosenCon in Charlotte, Guinness World Records recognized the most translated season of a
                streaming series: 125 languages for Season 1 of <em>The Chosen</em>. The 39 new languages
                added since September — Arabic, Bulgarian, Danish, Dutch, Haitian, Hindi, Korean, Slovenian,
                Turkish, Vietnamese, and more — were carried in low-resource contexts where many languages
                had just <b>one</b> subject-matter expert, delivering what once required a full team.
              </p>
            </div>
            <div className="aq-reveal" style={{ alignSelf: "center" }}>
              <div className="aq-stats" style={{ gridTemplateColumns: "1fr" }}>
                {/* Stats from codexeditor.app/case-studies/come-and-see. Verify current before launch. */}
                <div className="aq-stat">
                  <div className="aq-stat-num aq-display aq-gold-text">125</div>
                  <div className="aq-stat-label">languages for Season 1 of The Chosen</div>
                </div>
                <div className="aq-stat">
                  <div className="aq-stat-num aq-display aq-gold-text">2×</div>
                  <div className="aq-stat-label">back-to-back Guinness World Records</div>
                </div>
                <div className="aq-stat">
                  <div className="aq-stat-num aq-display aq-gold-text">240</div>
                  <div className="aq-stat-label">more translations already in the pipeline</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── The snowball effect ─────────────────────────────────────── */}
        <section className="aq-container aq-section" style={{ paddingTop: 0 }}>
          <div className="aq-head aq-center aq-reveal">
            <span className="aq-eyebrow">The snowball effect</span>
            <h2 className="aq-display">Every file makes the next one faster.</h2>
            <p>
              Living Memory compounds. Each completed file teaches the system more about the project's
              voice, terminology, and standards — so files started later finish faster per unit of work.
              Across 1,224 files and over 100 projects, the trend holds.
            </p>
          </div>
          <div className="aq-stats aq-reveal" style={{ maxWidth: "min(820px, 92vw)", margin: "40px auto 0" }}>
            <div className="aq-stat">
              <div className="aq-stat-num aq-display aq-gold-text">−0.18</div>
              <div className="aq-stat-label">weeks per 100 strings saved for every week of project timeline</div>
            </div>
            <div className="aq-stat">
              <div className="aq-stat-num aq-display aq-gold-text">0.74</div>
              <div className="aq-stat-label">R² — the acceleration is a consistent trend, not noise</div>
            </div>
            <div className="aq-stat">
              <div className="aq-stat-num aq-display aq-gold-text">1,224</div>
              <div className="aq-stat-label">files analyzed over 14 months of sustained acceleration</div>
            </div>
          </div>
          <div className="aq-reveal" style={{ textAlign: "center", marginTop: 26, color: "var(--aq-faint)", fontSize: 13, maxWidth: "min(680px, 90vw)", marginInline: "auto", lineHeight: 1.55 }}>
            Turnaround is measured as calendar weeks from first edit to last, normalized per 100 completed
            strings. Staffing and content difficulty shift individual files, but the downward slope is the
            compounding effect of Living Memory.
          </div>
        </section>

        {/* ── The road to 600 ─────────────────────────────────────────── */}
        <section className="aq-container aq-section" style={{ paddingTop: 0 }}>
          <div className="aq-reveal" style={{ maxWidth: "min(760px, 90vw)", margin: "0 auto", textAlign: "center" }}>
            <span className="aq-eyebrow">The road to 600</span>
            <blockquote className="aq-quote aq-display" style={{ marginTop: 22, color: "var(--aq-text)" }}>
              People need to hear the story of Jesus in their own language — the language they speak, dream, and pray in.
            </blockquote>
            <div className="aq-quote-cite"><b>James Barnett</b> · CEO, Come and See</div>
            <p style={{ marginTop: 28, fontSize: 17, lineHeight: 1.6, color: "var(--aq-dim)" }}>
              Six seasons into 600 languages is 33,000 episodes. It's reachable on one principle: amplify
              expertise instead of multiplying handoffs. The expert steers. The system learns. Quality is
              built in, not bolted on.
            </p>
          </div>
        </section>

        {/* ── Final CTA ───────────────────────────────────────────────── */}
        <section className="aq-container aq-section" style={{ paddingTop: 0 }}>
          <div className="aq-cta-band aq-reveal">
            <h2 className="aq-display">Scale your translation, <span className="aq-gold-text aq-display-italic">not your team.</span></h2>
            <p>Whether you're reaching into low-resource languages or speeding up the work you already do, Aquilla gives one expert maximum leverage. It's free, and it's live today.</p>
            <div className="aq-cta-actions">
              <a href="/onboarding" className="aq-btn aq-btn-gold aq-btn-lg">Start translating free</a>
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
function IconSpark() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 1l1.3 3.9L13 6 9.3 7.4 8 11 6.7 7.4 3 6l3.7-1.1z" /></svg> }
function IconSun() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="9" cy="9" r="3.6" /><path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M14.3 3.7l-1.4 1.4M5.1 12.9l-1.4 1.4" strokeLinecap="round" /></svg> }
function IconMoon() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M15 10.5A6.5 6.5 0 0 1 7.5 3a6.5 6.5 0 1 0 7.5 7.5z" strokeLinejoin="round" /></svg> }
