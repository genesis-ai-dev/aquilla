import { useCallback, useState } from "react"

/** Form-level error from async submit handlers (server/network). */
export function useSubmitError() {
  const [submitError, setSubmitError] = useState<string | null>(null)
  const clearSubmitError = useCallback(() => setSubmitError(null), [])
  return { submitError, setSubmitError, clearSubmitError }
}
