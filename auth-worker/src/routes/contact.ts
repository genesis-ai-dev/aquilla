// Public contact surface — mounted at /api/v2/contact in src/index.ts.
//
//   POST /book-call    NO auth (marketing homepage "book a call" form)
//   POST /newsletter   NO auth (newsletter signup — the aquilla.app/newsletter
//                      page + homepage section live in the separate
//                      `aquilla-marketing` repo and POST here cross-origin)
//
// Forwards submissions to the team inbox via the Cloudflare Email Service
// binding (services/email.ts → CONTACT_EMAIL, default joel@frontierrnd.com).
// Unauthenticated + sends email, so both routes are guarded two ways:
//   1. a honeypot field (`website`) that humans never see — a filled value
//      gets a quiet 200 with no send, so bots can't detect the trap;
//   2. a per-IP sliding-window throttle on auth_rate_limit_events
//      (kind "contact", utils/rate-limit.ts) so the endpoint can't be used
//      to bomb the inbox. The kind is shared across both forms on purpose:
//      same inbox, same abuse vector, one cap.
//
// The newsletter route is SELF-SERVE when the Resend secrets are configured
// (services/resend-audience.ts): the subscriber is added directly to the
// "Frontier R&D Newsletter" segment in Resend — the list of record — and the
// email to CONTACT_EMAIL becomes a heads-up, not an approval queue. Without
// the secrets (or if Resend is unreachable), it degrades to request-mode:
// the email IS the queue and the contact is added manually. Either way no
// subscriber data is stored server-side. See docs/partner-newsletter/PLAYBOOK.md.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Env, Variables } from "../types"
import { sendBookCallEmail, sendNewsletterRequestEmail } from "../services/email"
import { addNewsletterSubscriber } from "../services/resend-audience"
import {
  CONTACT_MAX_PER_IP,
  countRecentEvents,
  ipIdentifier,
  recordAuthEvent,
} from "../utils/rate-limit"

type HonoEnv = { Bindings: Env; Variables: Variables }

const bookCallSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: z.string().trim().email("A valid email is required").max(320),
  organization: z.string().trim().max(300).optional(),
  message: z.string().trim().max(5000).optional(),
  // Honeypot — rendered off-screen on the form; humans leave it empty.
  website: z.string().max(1000).optional(),
})

// Organization is REQUIRED here (unlike book-call): it's a partner letter,
// and the org name is what makes the subscriber notification meaningful.
const newsletterSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: z.string().trim().email("A valid email is required").max(320),
  organization: z.string().trim().min(1, "Organization is required").max(300),
  message: z.string().trim().max(2000).optional(),
  // Honeypot — rendered off-screen on the form; humans leave it empty.
  website: z.string().max(1000).optional(),
})

const app = new Hono<HonoEnv>()

app.post("/book-call", zValidator("json", bookCallSchema), async (c) => {
  const body = c.req.valid("json")

  // Bot filled the honeypot: pretend success, send nothing.
  if (body.website && body.website.trim() !== "") {
    return c.json({ ok: true, delivered: false })
  }

  const identifier = ipIdentifier(c.req.header("CF-Connecting-IP") || "unknown")
  const recent = await countRecentEvents(c.env.AQUILLA_PG, "contact", identifier, {
    onlyFailures: false,
  })
  if (recent >= CONTACT_MAX_PER_IP) {
    return c.json({ error: "Too many requests — please try again later." }, 429)
  }
  await recordAuthEvent(c.env.AQUILLA_PG, "contact", identifier, true)

  try {
    const { delivered } = await sendBookCallEmail(c.env, {
      name: body.name,
      email: body.email,
      organization: body.organization,
      message: body.message,
    })
    return c.json({ ok: true, delivered })
  } catch (err) {
    console.error("[contact] book-call send failed:", err)
    return c.json(
      { error: "We couldn't deliver your message — please email us directly." },
      502,
    )
  }
})

app.post("/newsletter", zValidator("json", newsletterSchema), async (c) => {
  const body = c.req.valid("json")

  // Bot filled the honeypot: pretend success, send nothing.
  if (body.website && body.website.trim() !== "") {
    return c.json({ ok: true, delivered: false })
  }

  const identifier = ipIdentifier(c.req.header("CF-Connecting-IP") || "unknown")
  const recent = await countRecentEvents(c.env.AQUILLA_PG, "contact", identifier, {
    onlyFailures: false,
  })
  if (recent >= CONTACT_MAX_PER_IP) {
    return c.json({ error: "Too many requests — please try again later." }, 429)
  }
  await recordAuthEvent(c.env.AQUILLA_PG, "contact", identifier, true)

  // Self-serve path: add straight to the Resend segment when configured.
  // No-op ({added:false, reason:"not_configured"}) when secrets are absent,
  // so tests stay offline and a pre-secret deploy behaves like request-mode.
  const subscribe = await addNewsletterSubscriber(c.env, {
    name: body.name,
    email: body.email,
  })

  // Heads-up email to CONTACT_EMAIL either way: visibility when self-serve
  // worked, the approval queue when it didn't.
  try {
    const { delivered } = await sendNewsletterRequestEmail(c.env, {
      name: body.name,
      email: body.email,
      organization: body.organization,
      message: body.message,
    })
    return c.json({ ok: true, delivered })
  } catch (err) {
    if (subscribe.added) {
      // Subscriber is on the list; only the notification failed. Don't turn
      // a successful signup into a user-facing error.
      console.error("[contact] newsletter notify failed (subscriber added):", err)
      return c.json({ ok: true, delivered: false })
    }
    console.error("[contact] newsletter request send failed:", err)
    return c.json(
      { error: "We couldn't deliver your request — please email us directly." },
      502,
    )
  }
})

export default app
