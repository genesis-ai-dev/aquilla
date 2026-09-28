// Self-serve newsletter signup — adds a subscriber directly to the Resend
// segment that the monthly partner-newsletter broadcast is sent to.
//
// Config (set as Worker secrets — dashboard: Settings → Variables and Secrets,
// or `npx wrangler secret put <NAME>`):
//   NEWSLETTER_RESEND_API_KEY     key from JOEL'S Resend account (contact management access)
//   NEWSLETTER_RESEND_SEGMENT_ID  the "Frontier R&D Newsletter" segment's ID
//
// NAMED DELIBERATELY: this worker already has a RESEND_API_KEY used for
// transactional auth email (EMAIL_FROM noreply@support.aquilla.app) via a
// DIFFERENT, older Resend account. Never reuse or overwrite that variable —
// the newsletter runs on Joel's separate Resend account and its own key.
//
// If either secret is missing, addNewsletterSubscriber() returns
// {added:false, reason:"not_configured"} without touching the network, and
// the route falls back to request-mode (notification email to CONTACT_EMAIL;
// Joel adds the contact manually). That makes this module safe to deploy
// before the secrets exist, and keeps unit tests offline.

type ResendConfig = {
  NEWSLETTER_RESEND_API_KEY?: string
  NEWSLETTER_RESEND_SEGMENT_ID?: string
}

export type SubscribeResult =
  | { added: true }
  | { added: false; reason: "not_configured" | "api_error" }

const RESEND_API = "https://api.resend.com"

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/)
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") }
}

export async function addNewsletterSubscriber(
  env: ResendConfig,
  input: { name: string; email: string },
): Promise<SubscribeResult> {
  const key = env.NEWSLETTER_RESEND_API_KEY
  const segmentId = env.NEWSLETTER_RESEND_SEGMENT_ID
  if (!key || !segmentId) return { added: false, reason: "not_configured" }

  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  }
  const { first, last } = splitName(input.name)

  // 1) Create the contact, attached to the newsletter segment in one call.
  const create = await fetch(`${RESEND_API}/contacts`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email: input.email,
      first_name: first,
      last_name: last,
      unsubscribed: false,
      segments: [{ id: segmentId }],
    }),
  })
  if (create.ok) return { added: true }
  const createErr = await create.text().catch(() => "")

  // 2) The contact may already exist (repeat signup, or already on the list
  //    with a different segment) — ensure segment membership by email.
  const attach = await fetch(
    `${RESEND_API}/contacts/${encodeURIComponent(input.email)}/segments/${segmentId}`,
    { method: "POST", headers },
  )
  if (attach.ok) return { added: true }

  console.error(
    "[newsletter] Resend subscribe failed — create:",
    create.status,
    createErr,
    "| segment attach:",
    attach.status,
  )
  return { added: false, reason: "api_error" }
}
