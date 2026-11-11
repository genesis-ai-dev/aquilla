// Place an IDML file's translations into the source a link just gave it.
//
// "Replace the source in my existing file" (AQU-1679) writes the upstream's
// source onto the file's own cells and keeps every translation. When the two
// IDML packages were not the same — the upstream was re-imported from a later
// edition, or an import that marks different runs editable — those kept
// translations are still shaped for the OLD source, and export refuses them
// until each is placed into the new runs. A re-import of the same file does
// that placement itself (`alignReimportedIdmlFile` after the reconcile); the
// link flows cannot, so they record the files (`link-adopted-align.ts`) and
// this hook, mounted by the workspace that holds the Align styles model, runs
// the identical placement with the same progress line.
//
// One pass per file per session: a placement that failed is left recorded for
// the next load rather than retried in a loop, and a file the project no longer
// lists is forgotten.

import { useEffect, useRef } from "react"
import { toast } from "@/components/ui/toast"
import { t } from "@/lib/i18n/standalone"
import {
  alignReimportedIdmlFile,
  type IdmlReimportAlignHost,
} from "@/lib/idml/align-reimported-targets"
import {
  clearAdoptedFileIdmlAlignment,
  useAdoptedFilesAwaitingIdmlAlignment,
} from "@/lib/idml/link-adopted-align"
import { triggerLinkSync } from "@/lib/sync/archive"

export interface AdoptedIdmlAlignmentFile {
  id: string
  name: string
  type: string
}

export interface UseAdoptedIdmlAlignmentArgs {
  projectId: string | null | undefined
  /** The project's files as the workspace lists them; `undefined` while loading. */
  files: readonly AdoptedIdmlAlignmentFile[] | undefined
  /** The signed-in session's token, for the sync that lands the join first. */
  jwt: string | null | undefined
  /** The active lane — the one a re-import aligns too. */
  lane: string
  getToken: (fileId: string) => Promise<string | null>
  /** The Align styles host, or the workspace's fallback whose `ask` throws. */
  host: IdmlReimportAlignHost
  sourceLanguage: string
  targetLanguage: string
  /** Test seam; production uses `triggerLinkSync`. */
  syncLink?: (jwt: string, projectId: string) => Promise<boolean>
}

export function useAdoptedIdmlAlignment(args: UseAdoptedIdmlAlignmentArgs): void {
  const { projectId, files, jwt, lane, getToken, host, sourceLanguage, targetLanguage, syncLink } = args
  const pending = useAdoptedFilesAwaitingIdmlAlignment(projectId)
  // One run at a time, and one attempt per file per session: the effect re-runs
  // on every render of a large component, and both guards make that free.
  const running = useRef(false)
  const attempted = useRef(new Set<string>())

  useEffect(() => {
    if (!projectId || !jwt || !files || pending.length === 0 || running.current) return
    const byId = new Map(files.map((file) => [file.id, file]))
    const work: AdoptedIdmlAlignmentFile[] = []
    for (const fileId of pending) {
      const file = byId.get(fileId)
      // Not an IDML file, or no longer in the project: nothing to place.
      if (!file || file.type !== "idml") {
        clearAdoptedFileIdmlAlignment(projectId, fileId)
        continue
      }
      if (!attempted.current.has(`${projectId}\u0000${fileId}`)) work.push(file)
    }
    if (work.length === 0) return
    running.current = true
    for (const file of work) attempted.current.add(`${projectId}\u0000${file.id}`)
    const run = runAlignment(projectId, jwt, work, {
      projectId, files, jwt, lane, getToken, host, sourceLanguage, targetLanguage, syncLink,
    })
    void run.finally(() => {
      running.current = false
    })
  }, [projectId, jwt, files, pending, lane, getToken, host, sourceLanguage, targetLanguage, syncLink])
}

async function runAlignment(
  projectId: string,
  jwt: string,
  work: readonly AdoptedIdmlAlignmentFile[],
  args: UseAdoptedIdmlAlignmentArgs,
): Promise<void> {
  // The join is the sync's first step and may still be pending (the link's
  // first sync failed, or the files were added without one). Placing against
  // the old source would find nothing to do and forget the file, so the sync
  // comes first; when it cannot run, the files stay recorded for the next load.
  const synced = await (args.syncLink ?? triggerLinkSync)(jwt, projectId)
  if (!synced) {
    console.warn("[link-adopt] IDML alignment deferred: the link could not be synced")
    return
  }
  for (const file of work) {
    const toastId = toast.add({
      type: "loading",
      title: t("projectSettings.linkSource.alignIdmlStarting", { fileName: file.name }),
      timeout: 0,
    })
    try {
      const outcome = await alignReimportedIdmlFile({
        projectId,
        fileId: file.id,
        lane: args.lane,
        getToken: args.getToken,
        host: args.host,
        sourceLanguage: args.sourceLanguage,
        targetLanguage: args.targetLanguage,
        onProgress: (done, total) => {
          toast.update(toastId, {
            type: "loading",
            title: t("importExport.upload.aligningIdmlStyles", {
              fileName: file.name,
              count: done.toLocaleString(),
              total: total.toLocaleString(),
            }),
          })
        },
      })
      clearAdoptedFileIdmlAlignment(projectId, file.id)
      if (outcome.manual.length > 0) {
        toast.update(toastId, {
          type: "warning",
          title: t("projectSettings.linkSource.alignIdmlManual", {
            fileName: file.name,
            count: outcome.manual.length,
          }),
          timeout: 8000,
        })
      } else if (outcome.aligned.length > 0) {
        toast.update(toastId, {
          type: "success",
          title: t("projectSettings.linkSource.alignIdmlDone", {
            fileName: file.name,
            count: outcome.aligned.length,
          }),
          timeout: 5000,
        })
      } else {
        // Every translation already fits the linked source: nothing to say.
        toast.close(toastId)
      }
    } catch (error) {
      console.warn("[link-adopt] IDML alignment failed", file.id, error)
      toast.update(toastId, {
        type: "error",
        title: t("projectSettings.linkSource.alignIdmlFailed", {
          fileName: file.name,
          message: error instanceof Error ? error.message : String(error),
        }),
        timeout: 8000,
      })
    }
  }
}
