// Tests for the "connect your AI agent" paste block (AQU-811).
//
// WHY these matter: this block is the only guidance a non-technical user gets
// for pointing an external agent at their Aquilla projects. If it drops the
// token, points at the wrong host, or omits the /api/v1/external path, the
// pasted instructions silently fail and the user has no way to tell why.

import { describe, it, expect } from "vitest"
import {
  buildAgentConnectInstructions,
  externalApiBase,
} from "./agent-connect-instructions"
import type { MintCredentialResult } from "./credentials"

function mintResult(overrides?: Partial<MintCredentialResult["credential"]>): MintCredentialResult {
  return {
    token: "aqk_livetoken123",
    credential: {
      id: "cred-1",
      name: "Import agent",
      mode: "ask",
      orgId: null,
      projectId: null,
      tokenPrefix: "aqk_live",
      createdAt: "2026-08-06T00:00:00.000Z",
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      ...overrides,
    },
  }
}

describe("buildAgentConnectInstructions", () => {
  it("embeds the real token, the external API base, and the MCP endpoint", () => {
    const text = buildAgentConnectInstructions({
      result: mintResult(),
      scope: "Acme Org",
      apiBase: "https://api.aquilla.app/sync/api/v1/external",
    })

    expect(text).toContain("aqk_livetoken123")
    expect(text).toContain("https://api.aquilla.app/sync/api/v1/external")
    // MCP endpoint is the base + /mcp, and the copy-paste `claude mcp add` line.
    expect(text).toContain("https://api.aquilla.app/sync/api/v1/external/mcp")
    expect(text).toContain('claude mcp add aquilla --transport http')
    // Bearer auth header with the live token.
    expect(text).toContain("Authorization: Bearer aqk_livetoken123")
  })

  it("never contains a placeholder token — only the real value", () => {
    const text = buildAgentConnectInstructions({
      result: mintResult(),
      scope: "Unscoped (personal)",
      apiBase: "https://api.aquilla.app/sync/api/v1/external",
    })
    expect(text).not.toMatch(/<[^>]*token[^>]*>/i)
    expect(text.toLowerCase()).not.toContain("your_token")
  })

  it("explains ask mode needs human approval", () => {
    const text = buildAgentConnectInstructions({
      result: mintResult({ mode: "ask" }),
      scope: "x",
      apiBase: "https://h/api/v1/external",
    })
    expect(text.toLowerCase()).toContain("ask")
    expect(text.toLowerCase()).toContain("approve")
  })

  it("explains act mode commits immediately", () => {
    const text = buildAgentConnectInstructions({
      result: mintResult({ mode: "act" }),
      scope: "x",
      apiBase: "https://h/api/v1/external",
    })
    expect(text.toLowerCase()).toContain("act")
    expect(text.toLowerCase()).toContain("immediately")
  })
})

describe("externalApiBase", () => {
  it("ends with the external API path segment", () => {
    // In the vitest env VITE_SYNC_WORKER_HOST is unset, so this resolves to the
    // dev host; we only assert the invariant path suffix, not the host.
    expect(externalApiBase()).toMatch(/\/api\/v1\/external$/)
  })
})
