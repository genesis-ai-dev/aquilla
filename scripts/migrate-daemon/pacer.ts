// Single-writer pacing for prod: token bucket (events/sec), adaptive chunk size,
// and a circuit breaker so a struggling Hyperdrive gets a pause, not a convoy.
export interface PacerOpts {
  eventsPerSec: number; chunkStart: number; chunkMin: number; chunkMax: number
  slowMs?: number; growAfter?: number; breakerAfter?: number; breakerPauseMs?: number; failPauseMs?: number
  now?: () => number; sleep?: (ms: number) => Promise<void>
}
export class Pacer {
  private tokens: number
  private last: number
  private chunk: number
  private okStreak = 0
  private failStreak = 0
  private breakerUntil: number | null = null
  private pendingPause = 0
  private readonly o: Required<PacerOpts>
  constructor(o: PacerOpts) {
    this.o = {
      slowMs: 3000, growAfter: 20, breakerAfter: 5, breakerPauseMs: 5 * 60_000, failPauseMs: 30_000,
      now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), ...o,
    }
    this.tokens = o.eventsPerSec
    this.last = this.o.now()
    this.chunk = o.chunkStart
  }
  get chunkSize(): number { return this.chunk }
  get paused(): boolean { return this.breakerUntil !== null && this.o.now() < this.breakerUntil }
  snapshot() { return { chunkSize: this.chunk, consecutiveOk: this.okStreak, consecutiveFail: this.failStreak, breakerOpenUntil: this.breakerUntil } }

  async acquire(events: number): Promise<void> {
    if (this.breakerUntil !== null) {
      const wait = this.breakerUntil - this.o.now()
      if (wait > 0) await this.o.sleep(wait)
      this.breakerUntil = null
      this.failStreak = 0
    }
    if (this.pendingPause > 0) { const p = this.pendingPause; this.pendingPause = 0; await this.o.sleep(p) }
    this.refill()
    if (this.tokens < events) {
      const need = events - this.tokens
      await this.o.sleep(Math.ceil((need / this.o.eventsPerSec) * 1000))
      this.refill()
    }
    this.tokens = Math.max(0, this.tokens - events)
  }
  private refill(): void {
    const now = this.o.now()
    this.tokens = Math.min(this.o.eventsPerSec, this.tokens + ((now - this.last) / 1000) * this.o.eventsPerSec)
    this.last = now
  }
  record(r: { ok: boolean; ms: number }): void {
    const bad = !r.ok || r.ms > this.o.slowMs
    if (bad) {
      this.okStreak = 0
      this.chunk = Math.max(this.o.chunkMin, Math.floor(this.chunk / 2))
      if (!r.ok) {
        this.failStreak++
        this.pendingPause = this.o.failPauseMs
        if (this.failStreak >= this.o.breakerAfter) this.breakerUntil = this.o.now() + this.o.breakerPauseMs
      }
      return
    }
    this.failStreak = 0
    if (++this.okStreak >= this.o.growAfter) {
      this.okStreak = 0
      this.chunk = Math.min(this.o.chunkMax, this.chunk * 2)
    }
  }
}
