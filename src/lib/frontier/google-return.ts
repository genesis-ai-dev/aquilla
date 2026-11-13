// Imported before application initialization: OAuth fragments must not reach
// telemetry, recordings or subsequent navigation. Kept only in this page's memory.
export const googleReturn = typeof window !== "undefined" && window.location.pathname === "/auth/google/return"
  ? new URLSearchParams(window.location.hash.slice(1)) : null
if (googleReturn) window.history.replaceState(window.history.state, "", window.location.pathname)
