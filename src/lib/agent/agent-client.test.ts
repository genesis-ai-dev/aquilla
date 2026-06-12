/**
 * agent-client tests — SSE frame parsing from scripted byte streams
 * (chunk boundaries falling mid-frame), runAgent request/auth wiring,
 * non-2xx handling, and abort.
 */

import { describe, it, expect, vi } from "vitest"
import { consumeAgentStream, runAgent, AGENT_RUN_URL } from "./agent-client"
import type { AgentFrame } from "./protocol"

const encoder = new TextEncoder()

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]))
      } else {
        controller.close()
      }
    },
  })
}

const FRAMES: AgentFrame[] = [
  { type: "run_start", runId: "run-1" },
  { type: "assistant_delta", text: "Looking at " },
  { type: "assistant_delta", text: "MRK 4…" },
  { type: "code_start", step: 1, kind: "sql", summary: "SELECT cell_id FROM cells…" },
  { type: "code_result", step: 1, ok: true, summary: "#c1|MRK 4:1|∅" },
  {
    type: "proposal",
    proposal: {
      proposalId: "p-1",
      runId: "run-1",
      summary: "Draft 1 cell in MRK 4",
      events: [
        {
          kind: "target.cell.commit",
          fileId: "f-1",
          cellId: "c-1",
          parentId: "evt-parent",
          payload: { value: "drafted", ai_suggestion: true, agent_run_id: "run-1" },
          display: { canonicalRef: "MRK 4:1", before: "", after: "drafted" },
        },
      ],
    },
  },
  { type: "usage", promptTokens: 1200, completionTokens: 340, costCents: 0.8 },
  { type: "done", runId: "run-1", status: "ok" },
]

function sseBody(frames: AgentFrame[]): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")
}

describe("consumeAgentStream", () => {
  it("parses every frame when chunk boundaries fall mid-frame", async () => {
    const body = sseBody(FRAMES)
    // Slice into awkward 17-byte chunks so `data:` prefixes and JSON bodies
    // straddle reads — the buffering must reassemble them.
    const chunks: string[] = []
    for (let i = 0; i < body.length; i += 17) chunks.push(body.slice(i, i + 17))

    const seen: AgentFrame[] = []
    await consumeAgentStream(streamFromChunks(chunks), (f) => seen.push(f))
    expect(seen).toEqual(FRAMES)
  })

  it("parses multiple frames arriving in one chunk and tolerates CRLF", async () => {
    const body = FRAMES.map((f) => `data: ${JSON.stringify(f)}\r\n\r\n`).join("")
    const seen: AgentFrame[] = []
    await consumeAgentStream(streamFromChunks([body]), (f) => seen.push(f))
    expect(seen).toEqual(FRAMES)
  })

  it("skips unparseable frames without killing the stream", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const body =
      `data: ${JSON.stringify(FRAMES[0])}\n` +
      `data: {broken json\n` +
      `: keepalive comment\n` +
      `data: ${JSON.stringify(FRAMES[7])}\n`
    const seen: AgentFrame[] = []
    await consumeAgentStream(streamFromChunks([body]), (f) => seen.push(f))
    expect(seen).toEqual([FRAMES[0], FRAMES[7]])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("throws AbortError when the signal aborts mid-stream", async () => {
    const controller = new AbortController()
    const chunks = [
      `data: ${JSON.stringify(FRAMES[0])}\n`,
      `data: ${JSON.stringify(FRAMES[1])}\n`,
    ]
    const seen: AgentFrame[] = []
    await expect(
      consumeAgentStream(
        streamFromChunks(chunks),
        (f) => {
          seen.push(f)
          controller.abort() // abort after the first frame lands
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(seen).toEqual([FRAMES[0]])
  })
})

describe("runAgent", () => {
  it("POSTs the run request with the chat Bearer token and streams frames", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: streamFromChunks([sseBody(FRAMES)]),
    })) as unknown as typeof fetch

    const seen: AgentFrame[] = []
    await runAgent({
      request: {
        projectId: "proj-1",
        messages: [{ role: "user", content: "draft mark 4" }],
        context: { fileId: "f-1", cellId: "c-1" },
      },
      jwt: "jwt-123",
      onFrame: (f) => seen.push(f),
      fetchImpl,
    })

    expect(seen).toEqual(FRAMES)
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(AGENT_RUN_URL)
    expect(AGENT_RUN_URL).toMatch(/\/api\/v1\/ai\/agent\/run$/)
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-123")
    expect(JSON.parse(init.body as string)).toEqual({
      projectId: "proj-1",
      messages: [{ role: "user", content: "draft mark 4" }],
      context: { fileId: "f-1", cellId: "c-1" },
    })
  })

  it("throws with status + body text on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "agent exploded",
    })) as unknown as typeof fetch

    await expect(
      runAgent({
        request: { projectId: "p", messages: [] },
        jwt: "jwt",
        onFrame: () => {},
        fetchImpl,
      }),
    ).rejects.toThrow(/500.*agent exploded/)
  })
})
