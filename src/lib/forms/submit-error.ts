import { useState } from "react"

/** Form-level error from async submit handlers (server/network). */
export function useSubmitError() {
  const [submitError, setSubmitError] = useState<string | null>(null)
  return { submitError, setSubmitError, clearSubmitError: () => setSubmitError(null) }
}
