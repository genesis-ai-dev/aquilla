// readModelTurn — one reader, two upstream dialects. WHY: the agent loop
// requests stream:true, but scripted mocks (this suite, mock-openrouter.ts)
// answer plain JSON; the reader must produce an IDENTICAL turn shape from
// both, and must reassemble tool-call arguments that arrive as SSE fragments
// split across chunk boundaries — a torn fragment would corrupt the JSON the
// tool executor parses.

import { describe, it, expect } from "vitest"
import { readModelTurn } from "../lib/agent/upstream"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

/** Build an SSE response whose byte chunks split exactly as given. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

describe("readModelTurn — JSON bodies (scripted mocks)", () => {
  it("returns the message, forwards content once, and surfaces usage", async () => {
    const deltas: string[] = []
    const turn = await readModelTurn(
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "All done." } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 },
      }),
      (t) => deltas.push(t),
    )
    expect(turn.message.content).toBe("All done.")
    expect(deltas).toEqual(["All done."])
    expect(turn.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, cost: 0.001 })
  })

  it("throws on a missing message and on an error body", async () => {
    await expect(readModelTurn(jsonResponse({ choices: [] }), () => {})).rejects.toThrow(
      "no message",
    )
    await expect(
      readModelTurn(jsonResponse({ error: { message: "model overloaded" } }), () => {}),
    ).rejects.toThrow("model overloaded")
  })
})

describe("readModelTurn — SSE streams", () => {
  it("forwards each content delta and assembles the full message", async () => {
    const deltas: string[] = []
    const turn = await readModelTurn(
      sseResponse([
        sse({ choices: [{ delta: { content: "Hel" } }] }),
        sse({ choices: [{ delta: { content: "lo " } }] }),
        sse({ choices: [{ delta: { content: "world" } }] }),
        sse({ usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.0001 } }),
        "data: [DONE]\n\n",
      ]),
      (t) => deltas.push(t),
    )
    expect(deltas).toEqual(["Hel", "lo ", "world"])
    expect(turn.message).toEqual({ role: "assistant", content: "Hello world" })
    expect(turn.usage?.prompt_tokens).toBe(10)
  })

  it("reassembles tool-call arguments split across frames AND byte boundaries", async () => {
    const frame1 = sse({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "tc1", type: "function", function: { name: "execute", arguments: '{"sql":' } },
            ],
          },
        },
      ],
    })
    const frame2 = sse({
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: '"SELECT 1"}' } }] } },
      ],
    })
    // Split frame1 mid-JSON to prove line buffering survives chunk tears.
    const tear = 25
    const turn = await readModelTurn(
      sseResponse([frame1.slice(0, tear), frame1.slice(tear) + frame2, "data: [DONE]\n\n"]),
      () => {},
    )
    expect(turn.message.tool_calls).toHaveLength(1)
    expect(turn.message.tool_calls![0]).toEqual({
      id: "tc1",
      type: "function",
      function: { name: "execute", arguments: '{"sql":"SELECT 1"}' },
    })
    expect(turn.message.content).toBeNull()
  })

  it("handles interleaved prose + tool calls and multiple tool-call indexes", async () => {
    const deltas: string[] = []
    const turn = await readModelTurn(
      sseResponse([
        sse({ choices: [{ delta: { content: "Reading… " } }] }),
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "a", function: { name: "execute", arguments: "{}" } },
                  { index: 1, id: "b", function: { name: "execute", arguments: '{"docs":"drafting"}' } },
                ],
              },
            },
          ],
        }),
        "data: [DONE]\n\n",
      ]),
      (t) => deltas.push(t),
    )
    expect(deltas).toEqual(["Reading… "])
    expect(turn.message.content).toBe("Reading… ")
    expect(turn.message.tool_calls?.map((t) => t.id)).toEqual(["a", "b"])
  })

  it("throws on a mid-stream error chunk and on an empty stream", async () => {
    await expect(
      readModelTurn(sseResponse([sse({ error: { message: "quota exceeded" } })]), () => {}),
    ).rejects.toThrow("quota exceeded")
    await expect(readModelTurn(sseResponse(["data: [DONE]\n\n"]), () => {})).rejects.toThrow(
      "no message",
    )
  })
})
