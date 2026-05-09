/**
 * React hook that wires a Y.Doc to the local store via the mirror registry.
 *
 *   const status = useMirrorRegistry(yDoc, currentUserId)
 *
 * Once the LocalStoreProvider's store is open AND `yDoc` is non-null, this
 * hook constructs a MirrorRegistry, registers the translation_text mirror,
 * and runs `startAll`. On unmount or any of the inputs changing, the
 * previous registry is torn down. Future phases register additional
 * mirrors here (threads, attachments, validations, …).
 *
 * Status values:
 *   - "no-store" — store not yet open (LocalStoreProvider is loading or the
 *                  hook is being used outside one)
 *   - "loading"  — store open but yDoc is null
 *   - "ready"    — registry attached; Y.Doc edits are mirroring
 */

import { useEffect, useState } from "react"
import type * as Y from "yjs"
import { useProjectStore } from "@/lib/local-store/provider"
import { MirrorRegistry, type MirrorContext } from "./registry"
import { createTranslationTextMirror } from "./translation-text-mirror"
import { createThreadsMirror } from "./threads-mirror"

export type MirrorRegistryStatus = "no-store" | "loading" | "ready"

export function useMirrorRegistry(
  yDoc: Y.Doc | null,
  actorId: string,
): MirrorRegistryStatus {
  const store = useProjectStore()
  const [status, setStatus] = useState<MirrorRegistryStatus>("no-store")

  useEffect(() => {
    if (!store) {
      setStatus("no-store")
      return
    }
    if (!yDoc) {
      setStatus("loading")
      return
    }

    const registry = new MirrorRegistry()
    registry.register(createTranslationTextMirror({ yDoc }))
    registry.register(createThreadsMirror({ yDoc }))

    const ctx: MirrorContext = {
      store,
      actorId,
      now: () => Date.now(),
    }

    let dispose: (() => void) | null = null
    let cancelled = false
    void registry.startAll(ctx).then((d) => {
      if (cancelled) {
        d()
        return
      }
      dispose = d
      setStatus("ready")
    })

    return () => {
      cancelled = true
      if (dispose) dispose()
    }
  }, [store, yDoc, actorId])

  return status
}
