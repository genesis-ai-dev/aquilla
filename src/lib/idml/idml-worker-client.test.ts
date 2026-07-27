import { describe, expect, it, vi } from "vitest"
import type {
  IdmlParseResult,
  IdmlSourceManifest,
} from "@aquilla/idml-roundtrip"
import type {
  IdmlWorkerRequest,
  IdmlWorkerResponse,
} from "@aquilla/idml-roundtrip/worker"
import {
  createIdmlWorkerClient,
  parseIdmlInWorker,
} from "./idml-worker-client"

const EMPTY_MANIFEST: IdmlSourceManifest = {
  version: 2,
  sourceSha256: "a".repeat(64),
  profile: "generic",
  members: [],
  unitLocators: [],
  diagnostics: [],
}

const EMPTY_PARSE: IdmlParseResult = {
  units: [],
  manifest: EMPTY_MANIFEST,
  diagnostics: [],
}

class ProtocolWorker {
  readonly requests: IdmlWorkerRequest[] = []
  readonly transfers: Transferable[][] = []
  terminated = false
  private readonly messageListeners = new Set<(event: MessageEvent<IdmlWorkerResponse>) => void>()
  private readonly errorListeners = new Set<(event: ErrorEvent) => void>()

  postMessage(message: IdmlWorkerRequest, transfer: Transferable[] = []): void {
    this.transfers.push(transfer)
    const cloned = structuredClone(message, { transfer }) as IdmlWorkerRequest
    this.requests.push(cloned)
    if (cloned.type === "cancel") return

    const result = cloned.method === "parse"
      ? EMPTY_PARSE
      : cloned.method === "inspect"
        ? {
            format: "idml",
            mimetype: "application/vnd.adobe.indesign-idml-package",
            byteLength: 1,
            members: [],
            diagnostics: [],
          }
        : cloned.method === "export"
          ? {
              bytes: new Uint8Array([1, 2, 3]),
              report: {
                translated: 0,
                unchanged: 0,
                missing: 0,
                rejected: 0,
                unsupported: 0,
                changedMemberPaths: [],
                originalByteLength: 0,
                exportedByteLength: 3,
                sizeDelta: 3,
                warnings: [],
              },
            }
          : []
    queueMicrotask(() => {
      this.emit({
        type: "progress",
        id: cloned.id,
        progress: { phase: "parse", completed: 1, total: 1 },
      })
      this.emit({ type: "success", id: cloned.id, result })
    })
  }

  addEventListener(type: string, listener: EventListener): void {
    if (type === "message") {
      this.messageListeners.add(listener as (event: MessageEvent<IdmlWorkerResponse>) => void)
    } else if (type === "error") {
      this.errorListeners.add(listener as (event: ErrorEvent) => void)
    }
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (type === "message") {
      this.messageListeners.delete(listener as (event: MessageEvent<IdmlWorkerResponse>) => void)
    } else if (type === "error") {
      this.errorListeners.delete(listener as (event: ErrorEvent) => void)
    }
  }

  terminate(): void {
    this.terminated = true
  }

  private emit(response: IdmlWorkerResponse): void {
    const event = { data: response } as MessageEvent<IdmlWorkerResponse>
    for (const listener of this.messageListeners) listener(event)
  }
}

describe("IDML worker client", () => {
  it("offers one reusable typed protocol for inspect/parse/export/validate", async () => {
    const endpoint = new ProtocolWorker()
    const progress: string[] = []
    const client = createIdmlWorkerClient({
      createWorker: () => endpoint as unknown as Worker,
    })

    await client.inspect(new Uint8Array([1]).buffer)
    await client.parse(new Uint8Array([2]).buffer, "biblica", {
      onProgress: (event) => progress.push(event.phase),
    })
    await client.export(new Uint8Array([3]).buffer, [])
    await client.validate(new Uint8Array([4]).buffer, EMPTY_MANIFEST)
    client.dispose()

    expect(endpoint.requests.map((request) => (
      request.type === "request" ? request.method : request.type
    ))).toEqual(["inspect", "parse", "export", "validate"])
    expect(endpoint.requests[1]).toMatchObject({ method: "parse", profile: "biblica" })
    expect(endpoint.transfers).toHaveLength(4)
    expect(endpoint.transfers.every((items) => items.length === 1)).toBe(true)
    expect(progress).toContain("parse")
    expect(endpoint.terminated).toBe(true)
  })

  it("transfers/detaches the caller buffer and never falls back inline", async () => {
    const endpoint = new ProtocolWorker()
    const bytes = new Uint8Array([1, 2, 3]).buffer

    await parseIdmlInWorker(
      bytes,
      "generic",
      undefined,
      { createWorker: () => endpoint as unknown as Worker },
    )

    expect(bytes.byteLength).toBe(0)
    expect(endpoint.terminated).toBe(true)
  })

  it("rejects cancellation and sends a cancel request", async () => {
    class HoldingWorker extends ProtocolWorker {
      override postMessage(message: IdmlWorkerRequest, transfer: Transferable[] = []): void {
        if (message.type === "cancel") {
          this.requests.push(message)
          return
        }
        this.transfers.push(transfer)
        this.requests.push(structuredClone(message, { transfer }) as IdmlWorkerRequest)
      }
    }
    const endpoint = new HoldingWorker()
    const controller = new AbortController()
    const client = createIdmlWorkerClient({
      createWorker: () => endpoint as unknown as Worker,
    })
    const operation = client.parse(new Uint8Array([1]).buffer, "generic", {
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(endpoint.requests).toHaveLength(1))
    controller.abort()

    await expect(operation).rejects.toMatchObject({ name: "AbortError" })
    expect(endpoint.requests.at(-1)).toMatchObject({ type: "cancel" })
    client.dispose()
  })
})
