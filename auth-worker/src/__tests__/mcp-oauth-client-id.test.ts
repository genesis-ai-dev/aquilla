import { describe, expect, it } from "vitest"
import { isClientIdUrl, isInternalHostname } from "../lib/mcp-oauth/client-metadata"

describe("client_id SSRF guard", () => {
  it("accepts public DNS client_id URLs", () => {
    expect(isClientIdUrl("https://chatgpt.com/oauth/client.json")).toBe(true)
  })

  it.each([
    "https://127.0.0.1/c.json",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/c.json",
    "https://2130706433/c.json",
    "https://0x7f000001/c.json",
    "https://[::1]/c.json",
    "https://localhost/c.json",
    "https://metadata/c.json",
    "https://db.internal/c.json",
    "https://printer.local/c.json",
  ])("rejects %s", (clientId) => {
    expect(isClientIdUrl(clientId)).toBe(false)
  })

  it("flags internal hostnames", () => {
    expect(isInternalHostname("Example.COM.")).toBe(false)
    expect(isInternalHostname("svc.corp")).toBe(true)
  })
})
