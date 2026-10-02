// Single-flight with one queued rerun.
//
// Plain single-flight ("a caller that arrives mid-run awaits the same run")
// is wrong for a job that reads state which may have changed after the run
// began: the late caller is answered from a read that predates the change it
// is asking about. The ProjectSync DO's mirror sync is that job — a push
// frame for an upstream commit that landed mid-sync joined the running fold,
// got its stale answer, and nothing asked again (AQU-1545).
//
// Here, a caller that arrives mid-run gets the NEXT run instead, which starts
// as soon as the current one settles (success or failure). Every caller that
// arrives while that next run is still waiting shares it, so any burst costs
// at most two runs back to back, and runs never overlap.

/**
 * Wrap `run` so concurrent calls never overlap and every call is answered by
 * a run that started after it was made. The queued run receives the arguments
 * of the call that queued it; callers that join it share that run, so only use
 * this where every concurrent call would pass equivalent arguments (one
 * instance per key).
 */
export function createRerunSingleFlight<A extends unknown[], T>(
  run: (...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  let inFlight: Promise<T> | null = null
  let queued: Promise<T> | null = null

  const request = (...args: A): Promise<T> => {
    if (!inFlight) {
      inFlight = run(...args).finally(() => {
        inFlight = null
      })
      return inFlight
    }
    if (!queued) {
      queued = inFlight
        .catch(() => undefined)
        .then(() => {
          queued = null
          return request(...args)
        })
    }
    return queued
  }

  return request
}
