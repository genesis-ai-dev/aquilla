import { describe, it, expect } from "vitest"
import { buildApprovedMessage, buildConnectionInstructions } from "./agent-connect"
describe("secret-free agent setup", () => {
  it("provides discovery, consent, secure storage and protocol polling instructions", () => {
    const prompt = buildConnectionInstructions("https://auth.example/identity/", "https://api.example/sync/")
    expect(prompt).toContain("https://auth.example/identity/api/v2/agent-connect")
    expect(prompt).toContain("https://api.example/sync/api/v1/external/me")
    expect(prompt).toContain('"scope":"ask"')
    expect(prompt).toContain("Never approve")
    expect(prompt).toContain("slow_down")
    expect(prompt).toContain("secure credential store")
    expect(prompt).not.toContain("aqk_")
    expect(prompt).not.toContain("Token:")
    // Agents lose their polling loop to tool timeouts; they must know to wait for the handoff.
    expect(prompt).toContain("keep device_code")
    // The point of connecting once: the agent registers a persistent MCP server
    // and the credential lasts until revoked, so no reconnect instructions.
    expect(prompt).toContain("MCP server")
    expect(prompt).toContain("does not expire")
    expect(prompt).not.toContain("30 days")
    // Python-urllib's default UA gets a non-JSON 403 from the edge (AQU-1512).
    expect(prompt).toContain("User-Agent")
  })
  it("tells a stalled agent to redeem without handing it any secret", () => {
    const message = buildApprovedMessage("https://auth.example/identity/", "ABCD-EFGH")
    expect(message).toContain("https://auth.example/identity/api/v2/agent-connect/token")
    expect(message).toContain("device_code you kept")
    expect(message).not.toContain("aqk_")
  })
})
