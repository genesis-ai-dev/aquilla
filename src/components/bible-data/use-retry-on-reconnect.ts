// Bible data (AQU-1692): load again after reconnecting.
//
// The pack loaders run once per book. A book opened offline, with nothing
// cached, stayed empty until the file was opened again. This counter goes up
// each time the browser comes back online while the last load failed for
// want of a connection; a loader keys its effect on it. A loaded book is never
// fetched again, because a new pack object would rebuild its index and
// re-render every row.

import { useEffect, useState } from "react"

export function useRetryOnReconnect(failedOffline: boolean): number {
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!failedOffline) return
    const retry = () => setAttempt((n) => n + 1)
    window.addEventListener("online", retry)
    return () => window.removeEventListener("online", retry)
  }, [failedOffline])
  return attempt
}
