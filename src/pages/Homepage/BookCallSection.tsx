// Homepage "Want to start? Book a call with us" section — a Google Calendar
// booking link (the team's Workspace appointment schedule, same link the case
// studies use) plus a contact form forwarded to the team inbox via
// POST /api/v2/contact/book-call (auth-worker routes/contact.ts).

import { useState, type FormEvent } from "react"
import { AUTH_BASE } from "@/lib/frontier/auth"

export const BOOKING_URL = "https://calendar.app.google/umM8GMgm6d78mZWS9"

type SubmitState = "idle" | "sending" | "sent" | "error"

export function BookCallSection() {
  const [state, setState] = useState<SubmitState>("idle")
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const data = new FormData(form)
    const payload = {
      name: String(data.get("name") ?? "").trim(),
      email: String(data.get("email") ?? "").trim(),
      organization: String(data.get("organization") ?? "").trim() || undefined,
      message: String(data.get("message") ?? "").trim() || undefined,
      // Honeypot — visually hidden; humans leave it empty.
      website: String(data.get("website") ?? ""),
    }
    setState("sending")
    setError(null)
    try {
      const res = await fetch(`${AUTH_BASE}/api/v2/contact/book-call`, {
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
      // Send successful leads straight to the booking page in a new tab —
      // the email gives the team the lead either way, and the sent state
      // keeps a visible calendar link in case a popup blocker eats this.
      window.open(BOOKING_URL, "_blank", "noopener,noreferrer")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong — please try again.")
      setState("error")
    }
  }

  return (
    <section className="aq-container aq-section" id="book-call" aria-labelledby="book-call-heading">
      <div className="aq-book">
        <div className="aq-feature-copy aq-reveal">
          <span className="aq-eyebrow">Talk to a human</span>
          <h2 className="aq-display" id="book-call-heading" style={{ marginTop: 14 }}>
            Want to start? <span className="aq-gold-text aq-display-italic">Book a call</span> with us
          </h2>
          <p>
            Tell us about your project — languages, media, team — and we'll walk you through how
            Aquilla fits. Pick a time that works for you, or send a note and we'll reach out.
          </p>
          <a
            href={BOOKING_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="aq-btn aq-btn-gold aq-btn-lg"
            style={{ marginTop: 10 }}
          >
            Book a call <IconArrowUpRight />
          </a>
          <p className="aq-book-alt">Prefer email? Use the form and we'll get back to you.</p>
        </div>

        <form className="aq-book-form aq-demo-card aq-reveal" onSubmit={onSubmit} noValidate={false}>
          {state === "sent" ? (
            <div className="aq-book-sent" role="status">
              <IconCheckBig />
              <h3 className="aq-display">Thanks — we'll be in touch.</h3>
              <p>
                Your message is on its way to the team, and our booking calendar should have
                opened in a new tab. If it didn't,{" "}
                <a href={BOOKING_URL} target="_blank" rel="noopener noreferrer">
                  grab a time on our calendar
                </a>
                .
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
                <span>Organization <em>(optional)</em></span>
                <input className="aq-input" name="organization" type="text" autoComplete="organization" placeholder="Team or organization" />
              </label>
              <label className="aq-field">
                <span>What are you hoping to translate? <em>(optional)</em></span>
                <textarea className="aq-input aq-textarea" name="message" rows={4} placeholder="Languages, media, timeline — anything helpful." />
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
                {state === "sending" ? "Sending…" : "Send message"}
              </button>
            </>
          )}
        </form>
      </div>
    </section>
  )
}

function IconArrowUpRight() {
  return <svg aria-hidden="true" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4.5 11.5l7-7M6 4.5h5.5V10" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function IconCheckBig() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="var(--aq-gold)" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.35" /><path d="M7.5 12.5l3 3 6-6.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
