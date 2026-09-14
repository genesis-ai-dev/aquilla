// Discord notifications for the daemon. Deliberately best-effort: a webhook
// outage must never fail a migration job, so every failure is logged and
// swallowed. The hourly digest keeps the channel to one message per hour
// instead of one per job.
import { retryingFetch } from "./http"

const MAX_LEN = 1900

export async function postDiscord(url: string, text: string): Promise<void> {
  try {
    await retryingFetch(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text.slice(0, MAX_LEN) }),
      },
      { attempts: 3 },
    )
  } catch (e) {
    console.log(`${new Date().toISOString()} discord post failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Rolling counters for the hourly summary. Reset by `hourly()`. */
export class Digest {
  done = 0
  failed = 0
  pushed = 0
  breakerTrips = 0
  since = Date.now()

  /** Render and reset. Returns undefined when nothing happened in the window. */
  hourly(): string | undefined {
    if (this.done === 0 && this.failed === 0 && this.pushed === 0 && this.breakerTrips === 0) {
      this.since = Date.now()
      return undefined
    }
    const mins = Math.round((Date.now() - this.since) / 60_000)
    const text =
      `migrate-daemon ${mins}m: ${this.done} job(s) done, ${this.failed} failed, ` +
      `${this.pushed} event(s) pushed, ${this.breakerTrips} breaker trip(s)`
    this.done = 0
    this.failed = 0
    this.pushed = 0
    this.breakerTrips = 0
    this.since = Date.now()
    return text
  }
}
