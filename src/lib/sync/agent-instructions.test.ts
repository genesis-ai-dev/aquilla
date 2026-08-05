// Tests for the agent-instructions prompt builder.
//
// WHY these matter: this string is the entire handoff between a human minting a
// token and an agent using it, and unlike everything else in the app it cannot
// be updated after it ships — once pasted into an agent chat it is frozen. That
// forces two properties, and these tests exist to hold them:
//
//   1. It must send the agent to the API's own discovery root and say the API
//      outranks the prompt. Endpoints and command kinds get added; a prompt that
//      enumerated them would quietly teach a stale surface forever.
//   2. It must NOT restate that surface itself. The "does it contain the right
//      endpoint list" test we're deliberately not writing would be the bug.
//
// Plus the two load-bearing safety claims: the ask-mode agent stops for a human
// instead of hammering commit, and the base URL is the one the token actually
// authenticates against.

import { describe, it, expect } from "vitest"
import { buildAgentInstructions, TOKEN_PLACEHOLDER } from "./agent-instructions"

const PROD = "https://api.aquilla.app/sync"

describe("buildAgentInstructions", () => {
  it("points at the /api/v1/external base on the given sync origin", () => {
    const text = buildAgentInstructions({
      syncOrigin: PROD,
      token: "aqk_live_abc",
      mode: "act",
      scopeLabel: "Blackfoot NT",
    })
    // The production sync host carries a /sync path segment that agents
    // routinely drop; the prompt must preserve it.
    expect(text).toContain("https://api.aquilla.app/sync/api/v1/external")
  })

  it("tolerates a trailing slash on the origin without doubling it", () => {
    const text = buildAgentInstructions({
      syncOrigin: "http://127.0.0.1:8787/",
      mode: "ask",
      scopeLabel: "Unscoped (personal)",
    })
    expect(text).toContain("http://127.0.0.1:8787/api/v1/external")
    expect(text).not.toContain("8787//api")
  })

  it("embeds the plaintext token in both the header example and the MCP command", () => {
    const text = buildAgentInstructions({
      syncOrigin: PROD,
      token: "aqk_live_abc",
      mode: "ask",
      scopeLabel: "Blackfoot NT",
    })
    expect(text).toContain("Authorization: Bearer aqk_live_abc")
    expect(text).toContain('--header "Authorization: Bearer aqk_live_abc"')
    expect(text).not.toContain(TOKEN_PLACEHOLDER)
  })

  it("falls back to a placeholder when the plaintext token is gone", () => {
    // Tokens are shown once. Every later view of these instructions can only
    // offer a placeholder — it must never render `undefined`.
    const text = buildAgentInstructions({
      syncOrigin: PROD,
      mode: "ask",
      scopeLabel: "Blackfoot NT",
    })
    expect(text).toContain(TOKEN_PLACEHOLDER)
    expect(text).not.toContain("undefined")
  })

  it("sends the agent to the discovery root first and ranks the live API above this prompt", () => {
    // The whole anti-staleness strategy is this instruction. If it goes, the
    // prompt silently becomes the agent's only model of the API.
    const text = buildAgentInstructions({
      syncOrigin: PROD,
      mode: "ask",
      scopeLabel: "Blackfoot NT",
    })
    expect(text).toMatch(/[Bb]efore anything else, fetch https:\/\/api\.aquilla\.app\/sync\/api\/v1\/external\b/)
    // …and says outright which one wins when they disagree.
    expect(text).toMatch(/the API is right/)
    // MCP callers get pointed at the equivalent discovery call, not a tool list.
    expect(text).toContain("get_capabilities")
  })

  it("does not enumerate endpoints or command kinds that the live API owns", () => {
    // These are exactly the facts that drift. The API publishes them at the
    // discovery root; a pasted prompt that also lists them can never be
    // corrected. Adding one here should fail this test, not ship silently.
    const text = buildAgentInstructions({
      syncOrigin: PROD,
      token: "aqk_live_abc",
      mode: "act",
      scopeLabel: "Blackfoot NT",
    })
    for (const kind of [
      "SetTranslation",
      "PlanImport",
      "CreateProject",
      "UpdateProjectSettings",
      "LinkMedia",
    ]) {
      expect(text).not.toContain(kind)
    }
    // No endpoint enumeration beyond the three bootstrap calls (root, /me,
    // /projects) an agent needs before it can read the map.
    for (const path of ["/changesets", "/artifacts", "/cells", "/files", "/search"]) {
      expect(text).not.toContain(path)
    }
  })

  it("tells an ask-mode agent to hand the approval URL to its human and stop", () => {
    const text = buildAgentInstructions({
      syncOrigin: PROD,
      token: "aqk_live_abc",
      mode: "ask",
      scopeLabel: "Blackfoot NT",
    })
    expect(text).toMatch(/ask-mode/)
    expect(text).toMatch(/paste it to me, stop, and wait/i)
    expect(text).toMatch(/[Dd]on't retry the commit in a loop/)
    // Ask mode must never be described as applying writes directly.
    expect(text).not.toMatch(/applied immediately/)
  })

  it("warns an act-mode agent that commits apply for real", () => {
    const text = buildAgentInstructions({
      syncOrigin: PROD,
      token: "aqk_live_abc",
      mode: "act",
      scopeLabel: "Blackfoot NT",
    })
    expect(text).toContain("applied immediately")
    expect(text).toMatch(/act-mode/)
    expect(text).not.toMatch(/wait for me to approve/)
  })

  it("states the credential's scope so the agent doesn't hunt for projects it can't reach", () => {
    const text = buildAgentInstructions({
      syncOrigin: PROD,
      mode: "ask",
      scopeLabel: 'project "Blackfoot NT"',
    })
    expect(text).toContain('project "Blackfoot NT"')
  })
})
