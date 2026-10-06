// Worker stand-in for the egress zip protocol (AQU-1269). Answers pack/unpack
// with the real zip core, so a test can assert that packaging was handed to a
// worker without giving up on checking the archive it produced.

import {
  packZip,
  unpackZip,
  type ZipWorkerRequest,
  type ZipWorkerResponse,
} from "../zip-core"
import type { ZipWorkerFactory } from "../zip-worker-client"

export type FakeZipReply = (req: ZipWorkerRequest) => Promise<unknown> | "crash"

/** Default behaviour: do the real work, succeed. */
export const replyWithRealZip: FakeZipReply = async (
  req: ZipWorkerRequest,
): Promise<ZipWorkerResponse> =>
  req.op === "pack"
    ? { id: req.id, ok: true, blob: await packZip(req.entries) }
    : { id: req.id, ok: true, entries: await unpackZip(req.bytes) }

export class FakeZipWorker implements Pick<Worker, "postMessage" | "terminate"> {
  readonly requests: ZipWorkerRequest[] = []
  terminated = false
  private readonly listeners = new Map<string, Set<EventListener>>()
  private readonly reply: FakeZipReply

  constructor(reply: FakeZipReply = replyWithRealZip) {
    this.reply = reply
  }

  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<EventListener>()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }
  terminate(): void {
    this.terminated = true
  }
  postMessage(message: ZipWorkerRequest): void {
    this.requests.push(message)
    const outcome = this.reply(message)
    if (outcome === "crash") {
      this.emit("error", { message: "boom" })
      return
    }
    void outcome.then((data) => this.emit("message", { data }))
  }
  /** The ops this worker was asked to run, in order. */
  get ops(): string[] {
    return this.requests.map((r) => r.op)
  }
  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as Event)
  }
}

export const zipWorkerFactory = (worker: FakeZipWorker): ZipWorkerFactory => async () =>
  worker as unknown as Worker
