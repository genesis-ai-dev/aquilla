// Outbound email via Cloudflare Email Service (the `send_email` binding,
// public beta 2026-04). The sending domain (EMAIL_FROM) must be onboarded
// under Compute > Email Service > Email Sending or sends fail with
// E_SENDER_NOT_VERIFIED. HTML templates are unchanged from the Resend era
// so reset/invite emails look the same as before the provider swap.

import type { Env } from "../types"

// Replies to our transactional mail must reach a human. EMAIL_FROM is an
// unmonitored `noreply@`, so every send sets Reply-To to this (routed) inbox
// unless a deploy overrides it via EMAIL_REPLY_TO. NOTE: this address must be
// wired up in Cloudflare Email Routing for a reply to actually land anywhere.
const DEFAULT_REPLY_TO = "support@aquilla.app"

function buildPasswordResetHtml(resetUrl: string): string {
  return `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #111;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #2563eb; margin-bottom: 16px;">Password Reset Request</h2>
          <p>We received a request to reset your password. If you didn't make this request, you can safely ignore this email.</p>
          <p style="margin: 20px 0; text-align: center;">
            <a href="${resetUrl}"
               style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 6px;">
              Reset Password
            </a>
          </p>
          <p>Or copy and paste this link into your browser:</p>
          <p style="background-color: #f3f4f6; padding: 10px; word-break: break-all;">
            ${resetUrl}
          </p>
          <p>This link will expire in 24 hours.</p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
          <p style="color: #6b7280; font-size: 0.875rem;">
            If you didn't request this password reset, please ignore this email or contact support if you have concerns.
          </p>
        </div>
      </body>
    </html>
  `.trim()
}

function buildProjectInviteHtml(joinUrl: string, projectName: string): string {
  return `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #111;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #2563eb; margin-bottom: 16px;">You've been invited to ${projectName}</h2>
          <p>You've been invited to collaborate on <strong>${projectName}</strong> in Aquilla.</p>
          <p style="margin: 20px 0; text-align: center;">
            <a href="${joinUrl}"
               style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 6px;">
              Accept invitation
            </a>
          </p>
          <p>Or copy and paste this link into your browser:</p>
          <p style="background-color: #f3f4f6; padding: 10px; word-break: break-all;">
            ${joinUrl}
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
          <p style="color: #6b7280; font-size: 0.875rem;">
            If you weren't expecting this invitation, you can safely ignore this email.
          </p>
        </div>
      </body>
    </html>
  `.trim()
}

function buildWelcomeHtml(
  username: string,
  appUrl: string,
  discordUrl?: string,
  verifyUrl?: string,
): string {
  const verifyBlock = verifyUrl
    ? `
          <p style="margin: 16px 0;">
            One quick thing — confirm your email so you don't lose access to your
            account:
          </p>
          <p style="margin: 16px 0; text-align: center;">
            <a href="${verifyUrl}"
               style="display: inline-block; padding: 10px 20px; background-color: #16a34a; color: white; text-decoration: none; border-radius: 6px;">
              Verify my email
            </a>
          </p>`
    : ""
  const communityBlock = discordUrl
    ? `
          <p style="margin: 16px 0;">
            Translation is a team effort — and so is building Aquilla. Come say
            hello, ask questions, and meet other teams in our community:
          </p>
          <p style="margin: 16px 0; text-align: center;">
            <a href="${discordUrl}"
               style="display: inline-block; padding: 10px 20px; background-color: #5865f2; color: white; text-decoration: none; border-radius: 6px;">
              Join the community
            </a>
          </p>`
    : ""
  // Support line. This email is sent from an unmonitored noreply@ address, so
  // point people at the live Discord (a real person answers there today) and
  // offer replies as a secondary path — the Reply-To routes them to support@.
  const supportLine = discordUrl
    ? `Got a question or stuck on something? Come find us in our
            <a href="${discordUrl}" style="color: #2563eb;">Discord community</a> —
            a real person answers. You can also just reply to this email.`
    : `Got a question or stuck on something? Just reply to this email — we
            read every message.`
  return `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #111;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #2563eb; margin-bottom: 16px;">Welcome to Aquilla, ${username} 👋</h2>
          <p>You're all set. Aquilla is where translation teams draft, review, and
             keep quality visible — together, without losing trust as you scale.</p>
          <p style="margin: 20px 0; text-align: center;">
            <a href="${appUrl}"
               style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 6px;">
              Open Aquilla
            </a>
          </p>
          <p>A good first step: create a project and import a source text, or invite
             your team if you're starting a project together.</p>
          ${verifyBlock}
          ${communityBlock}
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
          <p style="color: #6b7280; font-size: 0.875rem;">
            ${supportLine}
          </p>
        </div>
      </body>
    </html>
  `.trim()
}

/**
 * Send a welcome email after successful registration. Purely best-effort:
 * no-op without the EMAIL binding (local/e2e), and it swallows its own errors
 * so a flaky mail send can never affect the registration response. Callers
 * still fire-and-forget (waitUntil) so a slow send doesn't delay the response.
 */
export async function sendWelcomeEmail(
  env: Env,
  toEmail: string,
  username: string,
  verifyUrl?: string,
): Promise<void> {
  if (!env.EMAIL) return
  const from = env.EMAIL_FROM || "noreply@support.aquilla.app"
  const replyTo = env.EMAIL_REPLY_TO || DEFAULT_REPLY_TO
  const appUrl = env.BASE_URL || "https://aquilla.app"
  const discordUrl = env.DISCORD_INVITE_URL
  const html = buildWelcomeHtml(username, appUrl, discordUrl, verifyUrl)
  const text =
    `Welcome to Aquilla, ${username}! Open the app: ${appUrl}` +
    (verifyUrl ? `\nVerify your email: ${verifyUrl}` : "") +
    (discordUrl ? `\nJoin our community on Discord: ${discordUrl}` : "") +
    (discordUrl
      ? `\n\nQuestions or stuck? Ask in our Discord community (link above) — a real person answers. You can also just reply to this email.`
      : `\n\nQuestions or stuck? Just reply to this email — we read every message.`)
  try {
    await env.EMAIL.send({
      from,
      replyTo,
      to: [toEmail],
      subject: "Welcome to Aquilla",
      html,
      text,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn("[welcome] welcome email failed:", message)
  }
}

/**
 * Deliver a share-link invitation. Best-effort — callers fire-and-forget via
 * waitUntil; a missing EMAIL binding (local/e2e profiles) makes this a no-op
 * so dev/test don't require email config.
 */
export async function sendProjectInviteEmail(
  env: Env,
  toEmail: string,
  joinUrl: string,
  projectName: string,
): Promise<void> {
  if (!env.EMAIL) return
  const from = env.EMAIL_FROM || "noreply@support.aquilla.app"
  const replyTo = env.EMAIL_REPLY_TO || DEFAULT_REPLY_TO
  const html = buildProjectInviteHtml(joinUrl, projectName)
  const text = `You've been invited to ${projectName}. Accept: ${joinUrl}`
  try {
    await env.EMAIL.send({
      from,
      replyTo,
      to: [toEmail],
      subject: `You've been invited to ${projectName}`,
      html,
      text,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to send invite email: ${message}`)
  }
}

function buildOrgInviteHtml(joinUrl: string, orgName: string): string {
  return `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #111;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #2563eb; margin-bottom: 16px;">You've been invited to join ${orgName}</h2>
          <p>You've been invited to join the <strong>${orgName}</strong> organization on Aquilla,
             where translation teams work together.</p>
          <p style="margin: 20px 0; text-align: center;">
            <a href="${joinUrl}"
               style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 6px;">
              Join ${orgName}
            </a>
          </p>
          <p>Or copy and paste this link into your browser:</p>
          <p style="background-color: #f3f4f6; padding: 10px; word-break: break-all;">
            ${joinUrl}
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
          <p style="color: #6b7280; font-size: 0.875rem;">
            If you weren't expecting this invitation, you can safely ignore this email.
          </p>
        </div>
      </body>
    </html>
  `.trim()
}

/**
 * Deliver an organization invitation. Best-effort — callers fire-and-forget via
 * waitUntil; a missing EMAIL binding (local/e2e profiles) makes this a no-op so
 * dev/test don't require email config.
 */
export async function sendOrgInviteEmail(
  env: Env,
  toEmail: string,
  joinUrl: string,
  orgName: string,
): Promise<void> {
  if (!env.EMAIL) return
  const from = env.EMAIL_FROM || "noreply@support.aquilla.app"
  const replyTo = env.EMAIL_REPLY_TO || DEFAULT_REPLY_TO
  const html = buildOrgInviteHtml(joinUrl, orgName)
  const text = `You've been invited to join ${orgName} on Aquilla. Join: ${joinUrl}`
  try {
    await env.EMAIL.send({
      from,
      replyTo,
      to: [toEmail],
      subject: `You've been invited to join ${orgName}`,
      html,
      text,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to send org invite email: ${message}`)
  }
}

function buildAdminElevationHtml(code: string, ttlMinutes: number): string {
  return `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #111;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #2563eb; margin-bottom: 16px;">Admin console access code</h2>
          <p>Use this code to unlock the Aquilla admin console. If you didn't request it, you can ignore this email and your account stays locked.</p>
          <p style="margin: 24px 0; text-align: center;">
            <span style="display: inline-block; padding: 12px 24px; background-color: #f3f4f6; border-radius: 6px; font-size: 28px; letter-spacing: 8px; font-weight: bold;">
              ${code}
            </span>
          </p>
          <p>This code expires in ${ttlMinutes} minutes and can be used once.</p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
          <p style="color: #6b7280; font-size: 0.875rem;">
            This is a privileged-access step-up code. Never share it with anyone.
          </p>
        </div>
      </body>
    </html>
  `.trim()
}

/**
 * Email a step-up admin elevation code. Best-effort: returns false (does NOT
 * throw) when the EMAIL binding is absent (local/e2e), so the caller can fall
 * back to returning the code in the dev response. Returns true once handed to
 * the mail provider.
 */
export async function sendAdminElevationCodeEmail(
  env: Env,
  toEmail: string,
  code: string,
  ttlMinutes: number,
): Promise<boolean> {
  if (!env.EMAIL) return false
  const from = env.EMAIL_FROM || "noreply@support.aquilla.app"
  const replyTo = env.EMAIL_REPLY_TO || DEFAULT_REPLY_TO
  const html = buildAdminElevationHtml(code, ttlMinutes)
  const text = `Your Aquilla admin console access code is ${code}. It expires in ${ttlMinutes} minutes.`
  try {
    await env.EMAIL.send({
      from,
      replyTo,
      to: [toEmail],
      subject: "Your Aquilla admin access code",
      html,
      text,
    })
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn("[admin-elevation] code email failed:", message)
    return false
  }
}

export async function sendPasswordResetEmail(
  env: Env,
  toEmail: string,
  resetUrl: string,
): Promise<void> {
  if (!env.EMAIL) {
    throw new Error("EMAIL binding is not configured")
  }
  const from = env.EMAIL_FROM || "noreply@support.aquilla.app"
  const replyTo = env.EMAIL_REPLY_TO || DEFAULT_REPLY_TO
  const html = buildPasswordResetHtml(resetUrl)
  const text = `Reset your password: ${resetUrl}`
  try {
    await env.EMAIL.send({
      from,
      replyTo,
      to: [toEmail],
      subject: "Password Reset Request",
      html,
      text,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to send email: ${message}`)
  }
}
