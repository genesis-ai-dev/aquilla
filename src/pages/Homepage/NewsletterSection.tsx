// Homepage partner-newsletter section — a request form for the monthly
// Frontier R&D partner newsletter (Aquilla, Codex, LangQuest) that Joel
// (Head of Partnerships) sends to partner organizations. The list is
// CURATED: this form does not subscribe anyone. It POSTs to
// /api/v2/contact/newsletter (auth-worker routes/contact.ts), which emails
// the request to the partnerships inbox for approval. Editorial process:
// docs/partner-newsletter/PLAYBOOK.md.

import { useState, type FormEvent } from "react"
import { AUTH_BASE } from "@/lib/frontier/auth"

type SubmitState = "idle" | "sending" | "sent" | "error"

export function NewsletterSection() {
  const [state, setState] = useState<SubmitState>("idle")
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const data = new FormData(form)
    const payload = {
      name: String(data.get("name") ?? "").trim(),
      email: String(data.get("email") ?? "").trim(),
      organization: String(data.get("organization") ?? "").trim(),
      message: String(data.get("message") ?? "").trim() || undefined,
      // Honeypot — visually hidden; humans leave it empty.
      website: String(data.get("website") ?? ""),
    }
    setState("sending")
    setError(null)
    try {
      const res = await fetch(`${AUTH_BASE}/api/v2/contact/newsletter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `Request failed (${res.status})`)
      }
      form.reset()
      setState("sent")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong — please try again.")
      setState("error")
    }
  }

  return (
    <section
      className="aq-container aq-section"
      id="partner-letter"
      aria-labelledby="partner-letter-heading"
    >
      <div className="aq-book">
        <div className="aq-feature-copy aq-reveal">
          <span className="aq-eyebrow">For partners</span>
          <h2 className="aq-display" id="partner-letter-heading" style={{ marginTop: 14 }}>
            The Frontier R&amp;D <span className="aq-gold-text aq-display-italic">partner newsletter</span>
          </h2>
          <p>
            Once a month, Joel — our Head of Partnerships — writes a short letter to the
            organizations building with Frontier R&amp;D: what shipped across Aquilla, Codex,
            and LangQuest, what's changing, decisions we're making, and what we'd love your
            input on. No marketing, no filler — if a month is quiet, the letter is short.
          </p>
          <p className="aq-book-alt">
            The list is curated for partner organizations, so joining is a request — tell us who
            you are and we'll be in touch.
          </p>
        </div>

        <form className="aq-book-form aq-demo-card aq-reveal" onSubmit={onSubmit} noValidate={false}>
          {state === "sent" ? (
            <div className="aq-book-sent" role="status">
              <IconMailCheck />
              <h3 className="aq-display">Request received.</h3>
              <p>
                Joel reads every request. If it's a fit, you'll get a welcome note at the address
                you gave — and the next letter after that.
              </p>
            </div>
          ) : (
            <>
              <div className="aq-book-row">
                <label className="aq-field">
                  <span>Name</span>
                  <input className="aq-input" name="name" type="text" required autoComplete="name" placeholder="Your name" />
                </label>
                <label className="aq-field">
                  <span>Email</span>
                  <input className="aq-input" name="email" type="email" required autoComplete="email" placeholder="you@example.com" />
                </label>
              </div>
              <label className="aq-field">
                <span>Organization</span>
                <input className="aq-input" name="organization" type="text" required autoComplete="organization" placeholder="Your organization" />
              </label>
              <label className="aq-field">
                <span>How do you work with Aquilla? <em>(optional)</em></span>
                <textarea className="aq-input aq-textarea" name="message" rows={3} placeholder="Projects, languages, or how we're connected." />
              </label>
              {/* Honeypot: off-screen, skipped by humans, filled by naive bots. */}
              <label className="aq-book-hp" aria-hidden="true">
                Website
                <input name="website" type="text" tabIndex={-1} autoComplete="off" />
              </label>
              {state === "error" && error && (
                <p className="aq-book-error" role="alert">{error}</p>
              )}
              <button type="submit" className="aq-btn aq-btn-gold" disabled={state === "sending"}>
                {state === "sending" ? "Sending…" : "Request the newsletter"}
              </button>
            </>
          )}
        </form>
      </div>
    </section>
  )
}

function IconMailCheck() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="var(--aq-gold)" strokeWidth="2">
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" opacity="0.35" />
      <path d="M3.5 7l8.5 6 8.5-6M8.5 14.5l2 2 4-4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
