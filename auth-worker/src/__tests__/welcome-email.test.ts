// Tests for the welcome email (services/email.ts → sendWelcomeEmail).
//
// WHY these assertions matter: the welcome email is sent from an unmonitored
// `noreply@…` address, yet its copy invited users to "reply to this email — a
// real person reads it." That was a dead-end promise. The fix makes support
// honest two ways: (1) a Reply-To that routes replies to a monitored inbox
// instead of back at the noreply sender, and (2) a link to the live Discord
// community as the guaranteed support channel. These tests fail if either
// guarantee regresses.

import { describe, it, expect, vi } from "vitest"
import { sendWelcomeEmail } from "../services/email"
import type { EmailService, Env } from "../types"

type SendArg = Parameters<EmailService["send"]>[0]

/** A fake Email Service binding whose send() is a spy. */
function makeEmailBinding() {
  const send = vi.fn(async (_msg: SendArg) => ({ messageId: "test-id" }))
  return { send }
}

/** Minimal env carrying just the fields sendWelcomeEmail reads. */
function makeEnv(overrides: Partial<Env> = {}): { env: Env; email: ReturnType<typeof makeEmailBinding> } {
  const email = makeEmailBinding()
  const env = {
    EMAIL: email,
    EMAIL_FROM: "noreply@support.aquilla.app",
    BASE_URL: "https://aquilla.app",
    DISCORD_INVITE_URL: "https://discord.gg/T2EndwXe4W",
    ...overrides,
  } as unknown as Env
  return { env, email }
}

describe("sendWelcomeEmail — honest support path (no dead-end noreply promise)", () => {
  it("no-ops when the EMAIL binding is absent", async () => {
    const email = makeEmailBinding()
    await sendWelcomeEmail({ EMAIL: undefined } as unknown as Env, "u@example.com", "Ryder")
    expect(email.send).not.toHaveBeenCalled()
  })

  it("routes replies to a monitored inbox, not back at the unmonitored noreply sender", async () => {
    const { env, email } = makeEnv()
    await sendWelcomeEmail(env, "u@example.com", "Ryder")
    const msg = email.send.mock.calls[0][0]
    // Reply-To must exist and must NOT loop back to the noreply From address.
    expect(msg.replyTo).toBeTruthy()
    expect(msg.replyTo).not.toBe(msg.from)
    expect(msg.replyTo).toBe("support@aquilla.app")
  })

  it("honors an EMAIL_REPLY_TO override for the reply address", async () => {
    const { env, email } = makeEnv({ EMAIL_REPLY_TO: "hello@example.org" } as Partial<Env>)
    await sendWelcomeEmail(env, "u@example.com", "Ryder")
    expect(email.send.mock.calls[0][0].replyTo).toBe("hello@example.org")
  })

  it("offers the live Discord community as a support channel in both html and text", async () => {
    const { env, email } = makeEnv()
    await sendWelcomeEmail(env, "u@example.com", "Ryder")
    const msg = email.send.mock.calls[0][0]
    expect(msg.html).toContain("https://discord.gg/T2EndwXe4W")
    expect(msg.text).toContain("https://discord.gg/T2EndwXe4W")
  })

  it("keeps sending from the configured EMAIL_FROM address", async () => {
    const { env, email } = makeEnv()
    await sendWelcomeEmail(env, "u@example.com", "Ryder")
    expect(email.send.mock.calls[0][0].from).toBe("noreply@support.aquilla.app")
  })
})
