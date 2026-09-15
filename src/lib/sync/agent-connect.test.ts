import { describe, it, expect } from "vitest"
import { buildConnectionInstructions } from "./agent-connect"
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
  })
})
