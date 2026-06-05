// Probe microphone permission BEFORE starting a countdown.
// Returns "granted" | "denied" | "prompt" (unknown/needs-asking).
//
// Strategy:
//   1. Use the Permissions API (Chrome/Firefox) when available — non-intrusive.
//   2. If unavailable (Safari, some mobile), attempt a silent getUserMedia call
//      to force the system prompt now; resolve "granted" on success, "denied"
//      on NotAllowedError, "prompt" on any other error.
//
// This is exported for testing. The modal calls it before starting the countdown
// so permission is confirmed (or the error surfaced) before the 3-2-1 sequence
// begins. This prevents counting down into a failed recording. (FRO-155)

export async function probeMicPermission(): Promise<"granted" | "denied" | "prompt"> {
  // Permissions API path — does not trigger a browser prompt on its own.
  if (typeof navigator !== "undefined" && navigator.permissions) {
    try {
      const status = await navigator.permissions.query({ name: "microphone" as PermissionName })
      if (status.state === "granted") return "granted"
      if (status.state === "denied") return "denied"
      // state === "prompt" — fall through to getUserMedia probe below to
      // request access now (so the user sees the prompt before the countdown,
      // not in the middle of it).
    } catch {
      // Browser supports permissions API but not the "microphone" descriptor
      // (e.g. some Firefox builds). Fall through to getUserMedia probe.
    }
  }

  // getUserMedia probe — triggers the system permission dialog if needed.
  if (
    typeof navigator !== "undefined" &&
    navigator.mediaDevices &&
    navigator.mediaDevices.getUserMedia
  ) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const t of stream.getTracks()) t.stop()
      return "granted"
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotAllowedError") return "denied"
      // Any other error (NotFoundError, OverconstrainedError, etc.) — we can't
      // determine state definitively; let the caller proceed and the real
      // getUserMedia call in the recorder will surface the concrete error.
      return "prompt"
    }
  }

  // mediaDevices not available at all — let the recorder surface the error.
  return "prompt"
}
