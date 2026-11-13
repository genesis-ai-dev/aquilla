import { describe, expect, it } from "vitest"
import { readCapped, sandboxAdapter, type SandboxRpc } from "../src/resolve-sandbox"
import { SandboxFileTooLargeError, type SandboxRunResult } from "../src/sandbox"
import type { RunCodeOptions } from "../src/sandbox-do"

// The adapter between the route layer's SandboxLike (base64 strings, 0.x
// result shapes) and the Durable Object's byte-oriented RPC surface. The stub is
// a plain object here; in production it is env.Sandbox.getByName(sessionId).
class FakeStub implements SandboxRpc {
  runs: Array<{ code: string; options: RunCodeOptions }> = []
  written: Array<{ path: string; bytes: Uint8Array }> = []
  reads: string[] = []
  destroyed = 0
  file: Uint8Array | null = null

  async runCode(code: string, options: RunCodeOptions): Promise<SandboxRunResult> {
    this.runs.push({ code, options })
    return { logs: { stdout: ["ran"], stderr: [] }, results: [] }
  }
  async writeFile(path: string, content: ReadableStream<Uint8Array>): Promise<void> {
    this.written.push({ path, bytes: new Uint8Array(await new Response(content).arrayBuffer()) })
  }
  async readFile(path: string): Promise<ReadableStream<Uint8Array> | null> {
    this.reads.push(path)
    if (!this.file) return null
    return new Response(this.file).body
  }
  async destroy(): Promise<void> {
    this.destroyed++
  }
}

const utf8 = (s: string) => new TextEncoder().encode(s)

describe("sandboxAdapter", () => {
  it("maps runCode's timeout to the RPC's timeoutMs and keeps the language", async () => {
    const stub = new FakeStub()
    const result = await sandboxAdapter(stub).runCode("1+1", { language: "python", timeout: 5_000 })
    expect(stub.runs).toEqual([{ code: "1+1", options: { language: "python", timeoutMs: 5_000 } }])
    expect(result.logs.stdout).toEqual(["ran"])
  })

  it("decodes base64 uploads into the bytes the Durable Object writes", async () => {
    const stub = new FakeStub()
    const res = await sandboxAdapter(stub).writeFile("/workspace/a.bin", btoa("\x00\x01hi"), { encoding: "base64" })
    expect(res).toEqual({ success: true, path: "/workspace/a.bin" })
    expect(stub.written[0].path).toBe("/workspace/a.bin")
    expect(Array.from(stub.written[0].bytes)).toEqual([0, 1, 104, 105])
  })

  it("writes plain strings as UTF-8 and tolerates an empty file", async () => {
    const stub = new FakeStub()
    await sandboxAdapter(stub).writeFile("/workspace/t.txt", "héllo")
    expect(Array.from(stub.written[0].bytes)).toEqual(Array.from(utf8("héllo")))
    await sandboxAdapter(stub).writeFile("/workspace/empty", "", { encoding: "base64" })
    expect(stub.written[1].bytes.length).toBe(0)
  })

  it("reports a missing file as success:false (the route turns it into 404)", async () => {
    const stub = new FakeStub()
    const res = await sandboxAdapter(stub).readFile("/workspace/missing", { encoding: "base64" })
    expect(res).toEqual({ success: false, path: "/workspace/missing", content: "" })
    expect(stub.reads).toEqual(["/workspace/missing"])
  })

  it("returns file bytes as base64 when asked, with the size", async () => {
    const stub = new FakeStub()
    stub.file = utf8("payload")
    const res = await sandboxAdapter(stub).readFile("/workspace/out.bin", { encoding: "base64" })
    expect(res.success).toBe(true)
    expect(res.content).toBe(btoa("payload"))
    expect(res.isBinary).toBe(true)
    expect(res.size).toBe(7)
  })

  it("returns text otherwise", async () => {
    const stub = new FakeStub()
    stub.file = utf8("héllo")
    const res = await sandboxAdapter(stub).readFile("/workspace/t.txt")
    expect(res.content).toBe("héllo")
    expect(res.encoding).toBe("utf-8")
  })

  it("delegates destroy", async () => {
    const stub = new FakeStub()
    await sandboxAdapter(stub).destroy()
    expect(stub.destroyed).toBe(1)
  })
})

// The file a read carries out is whatever the code in the container wrote, so
// the drain is counted and abandoned at the cap instead of buffered whole.
describe("readCapped", () => {
  const streamOf = (chunks: Uint8Array[], onCancel?: () => void) =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift()
        if (next) controller.enqueue(next)
        else controller.close()
      },
      cancel() {
        onCancel?.()
      },
    })

  it("returns every byte of a file at the cap", async () => {
    const bytes = await readCapped(streamOf([utf8("abc"), utf8("def")]), 6)
    expect(new TextDecoder().decode(bytes)).toBe("abcdef")
  })

  it("refuses a file one byte over the cap and stops reading it", async () => {
    let cancelled = false
    const chunks = [utf8("abc"), utf8("defg"), utf8("never read")]
    await expect(readCapped(streamOf(chunks, () => (cancelled = true)), 6)).rejects.toBeInstanceOf(
      SandboxFileTooLargeError,
    )
    expect(cancelled).toBe(true)
    expect(chunks).toHaveLength(1)
  })
})
