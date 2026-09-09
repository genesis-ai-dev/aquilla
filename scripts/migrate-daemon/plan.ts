// A materialized plan is an NDJSON file on disk, one `PlanLine` per event, so a
// project's whole event stream never has to sit in memory at once: materialize
// streams lines out, push streams them back in batches.
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { createHash } from "node:crypto"
import type { IngestEvent } from "../../src/lib/migrate/types"

export interface PlanLine {
  id: string
  event: IngestEvent
  /** IDML `file.create` that must land before the source artifact is copied. */
  prerequisite?: true
  /** Set on retraction/resurrection/repair events from `computeOrphanRetractions`
   *  (Task 12 parity gate order check) — never on the mapper's own events, which
   *  interleave creates and deletes identically on both migrate-all and the
   *  daemon and carry no such ordering constraint. */
  reconcile?: true
  /** Content hash of the event's meaningful fields (Task 12 parity gate). */
  hash: string
}

/** Stable digest of everything that makes an event distinct from another one
 *  with the same id — the parity gate compares these against migrate-all. */
export function eventHash(e: IngestEvent): string {
  return createHash("sha256")
    .update(JSON.stringify({
      kind: e.kind,
      fileId: e.fileId ?? null,
      cellId: e.cellId ?? null,
      parentId: e.parentId ?? null,
      author: e.author,
      clientTs: e.clientTs,
      payload: e.payload,
    }))
    .digest("hex")
}

export class PlanWriter {
  private readonly stream: fs.WriteStream
  private count = 0
  readonly file: string
  constructor(file: string) {
    this.file = file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.stream = fs.createWriteStream(file, { flags: "w" })
  }
  /** Honours backpressure: a 17M-event plan would otherwise buffer the whole
   *  stream in memory when the disk cannot keep up. */
  async write(line: PlanLine): Promise<void> {
    this.count++
    if (!this.stream.write(`${JSON.stringify(line)}\n`)) {
      await new Promise<void>((resolve, reject) => {
        const onError = (e: Error): void => { this.stream.off("drain", onDrain); reject(e) }
        const onDrain = (): void => { this.stream.off("error", onError); resolve() }
        this.stream.once("error", onError)
        this.stream.once("drain", onDrain)
      })
    }
  }
  get lines(): number { return this.count }
  close(): Promise<{ lines: number }> {
    return new Promise((resolve, reject) => {
      this.stream.once("error", reject)
      this.stream.end(() => resolve({ lines: this.count }))
    })
  }
}

/** Yields the plan in batches of at most `batch` lines. */
export async function* readPlan(file: string, batch: number): AsyncGenerator<PlanLine[]> {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  let buf: PlanLine[] = []
  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      buf.push(JSON.parse(line) as PlanLine)
      if (buf.length >= batch) { yield buf; buf = [] }
    }
    if (buf.length) yield buf
  } finally {
    rl.close()
  }
}
