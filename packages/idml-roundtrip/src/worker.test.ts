import { describe, expect, it } from "vitest"

import { parseIdml } from "./engine.js"
import { makeIdml } from "./test-helpers/idml-fixture.js"
import {
  attachIdmlWorker,
  type IdmlWorkerEndpoint,
  type IdmlWorkerRequest,
  type IdmlWorkerResponse,
} from "./worker.js"

interface PostedMessage {
  readonly message: IdmlWorkerResponse
  readonly transfer: readonly Transferable[]
}

class MockWorkerEndpoint implements IdmlWorkerEndpoint {
  readonly posted: PostedMessage[] = []
  private listener?: (event: MessageEvent<IdmlWorkerRequest>) => void
  private readonly waiters: Array<{
    readonly predicate: (message: PostedMessage) => boolean
    readonly resolve: (message: PostedMessage) => void
  }> = []

  postMessage(message: IdmlWorkerResponse, transfer: Transferable[] = []): void {
    const posted = { message, transfer }
    this.posted.push(posted)
    const index = this.waiters.findIndex((waiter) => waiter.predicate(posted))
    if (index < 0) return
    const waiter = this.waiters.splice(index, 1)[0]
    waiter?.resolve(posted)
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<IdmlWorkerRequest>) => void,
  ): void {
    this.listener = listener
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<IdmlWorkerRequest>) => void,
  ): void {
    if (this.listener === listener) this.listener = undefined
  }

  dispatch(request: IdmlWorkerRequest): void {
    this.listener?.({ data: request } as MessageEvent<IdmlWorkerRequest>)
  }

  waitFor(predicate: (message: PostedMessage) => boolean): Promise<PostedMessage> {
    const existing = this.posted.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => {
      this.waiters.push({ predicate, resolve })
    })
  }
}

describe("IDML browser worker protocol", () => {
  it("runs inspect and parse requests with typed progress and results", async () => {
    const endpoint = new MockWorkerEndpoint()
    const detach = attachIdmlWorker(endpoint)
    const bytes = await makeIdml()

    endpoint.dispatch({
      type: "request",
      id: "inspect-1",
      method: "inspect",
      bytes: copyArrayBuffer(bytes),
    })
    const inspected = await endpoint.waitFor(
      ({ message }) => message.type === "success" && message.id === "inspect-1",
    )
    expect(inspected.message).toMatchObject({
      type: "success",
      result: { format: "idml" },
    })
    expect(
      endpoint.posted
        .filter(({ message }) => message.type === "progress" && message.id === "inspect-1")
        .map(({ message }) => message.type === "progress" && message.progress.completed),
    ).toEqual([0, 1])

    endpoint.dispatch({
      type: "request",
      id: "parse-1",
      method: "parse",
      bytes: copyArrayBuffer(bytes),
      profile: "biblica",
    })
    const parsed = await endpoint.waitFor(
      ({ message }) => message.type === "success" && message.id === "parse-1",
    )
    expect(parsed.message).toMatchObject({
      type: "success",
      result: { manifest: { profile: "biblica" } },
    })
    expect(
      endpoint.posted.some(
        ({ message }) =>
          message.type === "progress" &&
          message.id === "parse-1" &&
          message.progress.phase === "parse",
      ),
    ).toBe(true)
    detach()
  })

  it("transfers exported bytes and serializes typed IDML errors", async () => {
    const endpoint = new MockWorkerEndpoint()
    const detach = attachIdmlWorker(endpoint)
    const bytes = await makeIdml()
    const parsed = await parseIdml(bytes)
    const unit = parsed.units[0]!

    endpoint.dispatch({
      type: "request",
      id: "export-1",
      method: "export",
      bytes: copyArrayBuffer(bytes),
      translations: [
        {
          unitId: unit.id,
          locator: unit.locator,
          metadata: unit.metadata,
          sourceHtml: unit.sourceHtml,
          targetHtml: unit.sourceHtml.replace(" Bold ", " Translated "),
        },
      ],
    })
    const exported = await endpoint.waitFor(
      ({ message }) => message.type === "success" && message.id === "export-1",
    )
    expect(exported.message).toMatchObject({
      type: "success",
      result: { report: { translated: 1 } },
    })
    expect(exported.transfer).toHaveLength(1)
    expect(exported.transfer[0]).toBeInstanceOf(ArrayBuffer)

    endpoint.dispatch({
      type: "request",
      id: "bad-1",
      method: "inspect",
      bytes: Uint8Array.from([1, 2, 3]).buffer,
    })
    await expect(
      endpoint.waitFor(
        ({ message }) => message.type === "error" && message.id === "bad-1",
      ),
    ).resolves.toMatchObject({
      message: {
        type: "error",
        error: {
          name: "IdmlError",
          code: "INVALID_ZIP",
          diagnostics: [expect.objectContaining({ code: "INVALID_ZIP" })],
        },
      },
    })
    detach()
  })

  it("cancels active work through AbortController without elapsed-time polling", async () => {
    const endpoint = new MockWorkerEndpoint()
    const detach = attachIdmlWorker(endpoint)
    const bytes = await makeIdml()

    endpoint.dispatch({
      type: "request",
      id: "cancel-1",
      method: "parse",
      bytes: copyArrayBuffer(bytes),
    })
    endpoint.dispatch({ type: "cancel", id: "cancel-1" })

    await expect(
      endpoint.waitFor(
        ({ message }) => message.type === "error" && message.id === "cancel-1",
      ),
    ).resolves.toMatchObject({
      message: {
        type: "error",
        error: { name: "AbortError" },
      },
    })
    detach()
  })
})

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}
