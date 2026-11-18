import { describe, expect, it } from "vitest"
import { isClientIdUrl, isInternalHostname, resolveClient } from "../lib/mcp-oauth/client-metadata"

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

// The document's host is whoever supplied the client_id. A chunked body
// declares no length, so the cap has to stop the read, not judge it afterwards.
describe("client metadata size cap", () => {
  const CLIENT_ID = "https://client.example/oauth/client.json"

  it("stops reading a chunked body once it passes the cap", async () => {
    let pulled = 0
    let cancelled = false
    const chunk = new Uint8Array(8 * 1024)
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled++
          controller.enqueue(chunk)
        },
        cancel() {
          cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
    const result = await resolveClient(CLIENT_ID, async () => new Response(body))
    expect(result).toMatchObject({ ok: false, description: "client metadata document is too large" })
    expect(cancelled).toBe(true)
    // 16 KB cap, 8 KB chunks: the third chunk crosses it. An endless body is
    // never drained.
    expect(pulled).toBeLessThanOrEqual(4)
  })

  it("still accepts a document delivered in several chunks", async () => {
    const json = JSON.stringify({
      client_id: CLIENT_ID,
      client_name: "Example",
      redirect_uris: ["https://client.example/cb"],
    })
    const bytes = new TextEncoder().encode(json)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 10))
        controller.enqueue(bytes.slice(10))
        controller.close()
      },
    })
    const result = await resolveClient(CLIENT_ID, async () => new Response(body))
    expect(result).toMatchObject({ ok: true, client: { clientName: "Example", host: "client.example" } })
  })
})
