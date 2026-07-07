import { useEffect, useRef } from "react"
import { useBrand } from "@/branding/use-brand"
import { AppTooltip } from "@/components/ui/tooltip"
import { useMarketingShell } from "../Homepage/useMarketingShell"
import "../Homepage/homepage.css"

/**
 * Biblica Global Publishing customer story — a standalone marketing page
 * served at /case-studies/biblica (its own build entry + a worker
 * STATIC_PAGES line). Reuses the homepage surface (aq-* classes +
 * useMarketingShell), mirroring ComeAndSee.tsx.
 *
 * Quotes are from Noeline (Biblica's contact), shared directly for this
 * write-up. Verify figures (e.g. financial-year target, translation
 * timelines) are still current before launch.
 */
export function BiblicaCaseStudy() {
  const brand = useBrand()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { theme, toggleTheme } = useMarketingShell()

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

      <main className="aq-shell" id="top" aria-label="Biblica Global Publishing case study">
        {/* ── Hero ────────────────────────────────────────────────────── */}
        <section className="aq-container aq-hero">
          <img
            src="/biblica-logo.svg"
            alt="Biblica"
            className="aq-load aq-d1"
            style={{ height: 40, width: "auto", marginBottom: 4 }}
          />
          <div className="aq-hero-eyebrow aq-load aq-d1">
            <span className="aq-dot" aria-hidden="true" /> Partner story · Biblica Global Publishing
          </div>
          <h1 className="aq-display aq-load aq-d2">
            From traditional publisher <span className="aq-gold-text aq-display-italic">to AI publisher.</span>
          </h1>
          <p className="aq-hero-sub aq-load aq-d3">
            Biblica's Global Publishing team carries close to 130 years of combined traditional publishing
            experience. Instead of holding the line, they moved almost their entire resource-translation
            workflow onto Aquilla — and became the first team to take a Study Bible translation straight
            to a typeset, print-ready PDF.
          </p>
          <div className="aq-hero-actions aq-load aq-d4">
            <a href="/onboarding" className="aq-btn aq-btn-gold aq-btn-lg">Start translating free</a>
            <a href="#print-ready" className="aq-btn aq-btn-ghost aq-btn-lg">The print-ready win <IconArrow /></a>
          </div>
        </section>

        {/* ── Mindset shift ────────────────────────────────────────────── */}
        <section className="aq-container aq-section" id="mindset">
          <div className="aq-feature" style={{ alignItems: "start" }}>
            <div className="aq-feature-copy aq-reveal">
              <span className="aq-eyebrow">Opportunity, not threat</span>
              <h3 className="aq-display" style={{ marginTop: 14 }}>Coming from a traditional publishing background.</h3>
              <p>
                Biblica's Publishing Team takes great pride in time-honoured processes and doing things
                well. Embracing AI meant a genuine mindset shift — and a willingness to move outside a
                comfort zone built over decades.
              </p>
            </div>
            <div className="aq-reveal" style={{ alignSelf: "center" }}>
              <p className="aq-quote aq-display" style={{ color: "var(--aq-text)" }}>
                Many people see AI as potentially threatening their jobs. But this is misinformation.
                Embracing AI hasn't impacted our livelihoods negatively at all — it's put us in great
                demand and opened up all kinds of opportunities and possibilities for us.
              </p>
              <div className="aq-quote-cite" style={{ marginTop: 12 }}><b>Noeline</b> · Biblica Global Publishing</div>
            </div>
          </div>
        </section>

        {/* ── Team willing to change ──────────────────────────────────── */}
        <section className="aq-container aq-section" style={{ paddingTop: 0 }}>
          <div className="aq-head aq-center aq-reveal">
            <span className="aq-eyebrow">A team willing to change</span>
            <h2 className="aq-display">130 years of experience — and no attachment to "we've always done it this way."</h2>
            <p>
              It would have been easy for a team this experienced to stay put. Instead, they pushed the
              boundaries and completely changed how they work.
            </p>
          </div>
          <div className="aq-reveal" style={{ maxWidth: "min(760px, 90vw)", margin: "36px auto 0" }}>
            <blockquote className="aq-quote aq-display" style={{ color: "var(--aq-text)", textAlign: "center" }}>
              It's been an amazing experience to move outside our comfort zone and not feel threatened.
            </blockquote>
          </div>
        </section>

        {/* ── Print-ready output ───────────────────────────────────────── */}
        <section className="aq-container aq-section" id="print-ready" style={{ paddingTop: 0 }}>
          <div className="aq-feature aq-rev" style={{ alignItems: "start" }}>
            <div className="aq-feature-copy aq-reveal">
              <span className="aq-eyebrow">The big win</span>
              <h3 className="aq-display" style={{ marginTop: 14 }}>Translation to typeset, print-ready PDF.</h3>
              <p>
                AI-assisted translation is already happening elsewhere — that's not new. The breakthrough
                is taking a translation straight through to a print-ready PDF. With the Frontier team,
                Biblica found a way to do that for a Study Bible: an output that's literally typeset,
                saving the hugest amount of time in the publishing pipeline.
              </p>
            </div>
            <div className="aq-reveal" style={{ alignSelf: "center" }}>
              <p className="aq-quote aq-display" style={{ color: "var(--aq-text)" }}>
                I don't think anybody else has done this with a Study Bible. Being able to end up with a
                print-ready document — that's game-changing.
              </p>
            </div>
          </div>
        </section>

        {/* ── The right AI partner ─────────────────────────────────────── */}
        <section className="aq-container aq-section" style={{ paddingTop: 0 }}>
          <div className="aq-head aq-center aq-reveal">
            <span className="aq-eyebrow">The right AI partner</span>
            <h2 className="aq-display">Stable, accurate, and reviewable in time.</h2>
            <p>
              Finding the right partner was critical: first a translation method that was stable, accurate,
              and allowed for in-time review — then a team that could help achieve the ultimate goal of
              print output.
            </p>
          </div>
          <div className="aq-reveal" style={{ maxWidth: "min(760px, 90vw)", margin: "36px auto 0" }}>
            <blockquote className="aq-quote aq-display" style={{ color: "var(--aq-text)", textAlign: "center" }}>
              In a situation where AI can be seen as impersonal, the Frontier team provide an incredibly
              personal experience.
            </blockquote>
          </div>
        </section>

        {/* ── Becoming an AI publisher ─────────────────────────────────── */}
        <section className="aq-container aq-section" style={{ paddingTop: 0 }}>
          <div className="aq-feature" style={{ alignItems: "start" }}>
            <div className="aq-feature-copy aq-reveal">
              <span className="aq-eyebrow">Becoming an AI publisher</span>
              <h3 className="aq-display" style={{ marginTop: 14 }}>From a 50% goal to nearly 100%.</h3>
              <p>
                The goal was to be functioning as a 50% AI publisher by the end of the financial year
                (30 September). Biblica will achieve almost 100% — and will move all resource translations
                onto Aquilla from October 1.
              </p>
            </div>
            <div className="aq-reveal" style={{ alignSelf: "center" }}>
              <div className="aq-stats" style={{ gridTemplateColumns: "1fr" }}>
                <div className="aq-stat">
                  <div className="aq-stat-num aq-display aq-gold-text">~100%</div>
                  <div className="aq-stat-label">AI-publisher functioning, up from a 50% target</div>
                </div>
                <div className="aq-stat">
                  <div className="aq-stat-num aq-display aq-gold-text">Oct 1</div>
                  <div className="aq-stat-label">all resource translations move onto Aquilla</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Full Bible in a year ─────────────────────────────────────── */}
        <section className="aq-container aq-section" style={{ paddingTop: 0 }}>
          <div className="aq-head aq-center aq-reveal">
            <span className="aq-eyebrow">The Innovation Lab</span>
            <h2 className="aq-display">A full Bible update, translated in twelve months.</h2>
            <p>
              On June 1, Biblica took on two projects for the Innovation Lab: updating full Spanish and
              Portuguese Bibles from old source texts on Aquilla. Both were completed in twelve months.
            </p>
          </div>
          <div className="aq-beta-cards aq-reveal">
            {[
              {
                t: "Reference, not print",
                d: "These texts aren't meant for print output — they'll be published online for reference purposes. A print run would have needed an additional period for further checks and balances.",
              },
              {
                t: "Established languages, experienced reviewers",
                d: "Spanish and Portuguese are established languages, and two experienced reviewers worked each language's AI translations.",
              },
              {
                t: "Real-time review, real-time learning",
                d: "Reviewers reported positive experiences and were happy with the first outputs. Doing the review and correction phase in real time — with the system learning as it went — was a real plus.",
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
        </section>

        {/* ── Last-mile framing ────────────────────────────────────────── */}
        <section className="aq-container aq-section" style={{ paddingTop: 0 }}>
          <div className="aq-reveal" style={{ maxWidth: "min(760px, 90vw)", margin: "0 auto", textAlign: "center" }}>
            <span className="aq-eyebrow">Why speed matters</span>
            <blockquote className="aq-quote aq-display" style={{ marginTop: 22, color: "var(--aq-text)" }}>
              As organisations move into last-mile-first areas, you can't take up to ten years to translate
              a Bible. New ways are going to have to be found to speed up Bible translation if we are to
              meet Last-Mile-First goals.
            </blockquote>
            <div className="aq-quote-cite"><b>Noeline</b> · Biblica Global Publishing</div>
          </div>
        </section>

        {/* ── Final CTA ───────────────────────────────────────────────── */}
        <section className="aq-container aq-section" style={{ paddingTop: 0 }}>
          <div className="aq-cta-band aq-reveal">
            <h2 className="aq-display">Scale your translation, <span className="aq-gold-text aq-display-italic">not your team.</span></h2>
            <p>Whether you're chasing a print-ready output or a faster path into last-mile languages, Aquilla gives one expert maximum leverage. It's free, and it's live today.</p>
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
            <span>Made for the All-Access Goals · Scripture for every language by 2033.</span>
          </div>
        </div>
      </footer>
    </div>
  )
}

/* ── Icons ──────────────────────────────────────────────────────────────── */
function IconArrow() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" /></svg> }
function IconSpark() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 1l1.3 3.9L13 6 9.3 7.4 8 11 6.7 7.4 3 6l3.7-1.1z" /></svg> }
function IconSun() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="9" cy="9" r="3.6" /><path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M14.3 3.7l-1.4 1.4M5.1 12.9l-1.4 1.4" strokeLinecap="round" /></svg> }
function IconMoon() { return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M15 10.5A6.5 6.5 0 0 1 7.5 3a6.5 6.5 0 1 0 7.5 7.5z" strokeLinejoin="round" /></svg> }
