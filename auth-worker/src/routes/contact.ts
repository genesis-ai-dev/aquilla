// Public contact surface — mounted at /api/v2/contact in src/index.ts.
//
//   POST /book-call    NO auth (marketing homepage "book a call" form)
//
// Forwards the submission to the team inbox via the Cloudflare Email Service
// binding (services/email.ts → CONTACT_EMAIL, default joel@frontierrnd.com).
// Unauthenticated + sends email, so it's guarded two ways:
//   1. a honeypot field (`website`) that humans never see — a filled value
//      gets a quiet 200 with no send, so bots can't detect the trap;
//   2. a per-IP sliding-window throttle on auth_rate_limit_events
//      (kind "contact", utils/rate-limit.ts) so the endpoint can't be used
//      to bomb the inbox.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Env, Variables } from "../types"
import { sendBookCallEmail } from "../services/email"
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

export default app
