// Outbound email via Resend. Used only by the password-reset request flow.
// Ported verbatim (minus untyped imports) from
// frontier-server/cloudflare/src/services/email.ts so the reset emails look
// the same regardless of which worker handled the request.

import type { Env } from "../types"

interface ResendErrorResponse {
  message?: string
  name?: string
}

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

/**
 * Deliver a share-link invitation. Best-effort — callers fire-and-forget via
 * waitUntil; a missing RESEND_API_KEY makes this a no-op so dev/test don't
 * require email config.
 */
export async function sendProjectInviteEmail(
  env: Env,
  toEmail: string,
  joinUrl: string,
  projectName: string,
): Promise<void> {
  if (!env.RESEND_API_KEY) return
  const from = env.EMAIL_FROM || "noreply@frontierrnd.com"
  const html = buildProjectInviteHtml(joinUrl, projectName)
  const text = `You've been invited to ${projectName}. Accept: ${joinUrl}`
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [toEmail],
      subject: `You've been invited to ${projectName}`,
      html,
      text,
    }),
  })
  if (!response.ok) {
    let errorMessage = `Failed to send invite email: ${response.status}`
    try {
      const errorBody = (await response.json()) as ResendErrorResponse
      if (errorBody?.message) errorMessage = `Failed to send invite email: ${errorBody.message}`
    } catch {
      // ignore
    }
    throw new Error(errorMessage)
  }
}

export async function sendPasswordResetEmail(
  env: Env,
  toEmail: string,
  resetUrl: string,
): Promise<void> {
  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured")
  }
  const from = env.EMAIL_FROM || "noreply@frontierrnd.com"
  const html = buildPasswordResetHtml(resetUrl)
  const text = `Reset your password: ${resetUrl}`
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [toEmail],
      subject: "Password Reset Request",
      html,
      text,
    }),
  })
  if (!response.ok) {
    let errorMessage = `Failed to send email: ${response.status}`
    try {
      const errorBody = (await response.json()) as ResendErrorResponse
      if (errorBody?.message) {
        errorMessage = `Failed to send email: ${errorBody.message}`
      }
    } catch {
      // ignore JSON parse errors
    }
    throw new Error(errorMessage)
  }
}
