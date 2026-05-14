import { useSyncExternalStore } from "react"
import { isOpfsAvailable, subscribeOpfsAvailability } from "@/lib/storage/opfs-availability"

export function useOpfsAvailability(): boolean {
  return useSyncExternalStore(
    (notify) => subscribeOpfsAvailability(() => notify()),
    isOpfsAvailable,
    () => true,
  )
}
