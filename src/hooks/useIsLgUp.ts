import { useSyncExternalStore } from "react"

/** Tailwind `lg` — below this, the workspace dock moves into a sheet. */
const LG_MIN_WIDTH_QUERY = "(min-width: 1024px)"

export function useIsLgUp(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const mq = window.matchMedia(LG_MIN_WIDTH_QUERY)
      mq.addEventListener("change", onStoreChange)
      return () => mq.removeEventListener("change", onStoreChange)
    },
    () => window.matchMedia(LG_MIN_WIDTH_QUERY).matches,
    () => true,
  )
}
