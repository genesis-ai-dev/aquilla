import { useEffect } from "react"
import { useSyncExternalStore } from "react"
import {
  isStorageNearlyFull,
  refreshStoragePressure,
  requestPersistentStorage,
  subscribeStoragePressure,
} from "@/lib/storage/storage-pressure"

/**
 * Whether this browser origin is nearly out of room (AQU-1865).
 *
 * Mounting this also does the two one-off things the app owes its storage:
 * asks for persistent storage (so the browser stops evicting a queued edit
 * under disk pressure) and takes one estimate, so the warning can appear
 * before a write has to fail to discover the disk is full.
 */
export function useStoragePressure(): boolean {
  useEffect(() => {
    void requestPersistentStorage()
    void refreshStoragePressure()
  }, [])
  return useSyncExternalStore(
    (notify) => subscribeStoragePressure(() => notify()),
    isStorageNearlyFull,
    () => false,
  )
}
