import { useEffect, useRef } from "react"
import { toast } from "@/components/ui/toast"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  isChapterPageComplete,
  type ChapterPageDestination,
} from "@/lib/chapter-navigation"
import type { ChapterCompletionAction, ChapterCompletionTrigger } from "@/lib/parsers/types"

/** One toast: retitled in place while you stay; dismissed when you leave. */
export const CHAPTER_COMPLETE_TOAST_ID = "chapter-complete-advance"

type WorkCell = {
  original: string
  translated: string
  status: string
  medium?: import("@/lib/sync/cells-read-types").SegmentMedium | null
  transcription?: string
}

/**
 * AQU-1087: prompt and auto-advance run only on a rising edge — the open
 * chapter becoming complete while you are on it. Landing on a chapter that
 * is already done does nothing.
 *
 * One notification. Leaving the chapter (or hitting an incomplete/last page)
 * dismisses it.
 */
export function useChapterCompletionAdvance(args: {
  enabled: boolean
  fileId: string | null
  pageKey: string
  subsectionKey?: string | null
  currentLabel: string
  next: ChapterPageDestination | null
  trigger: ChapterCompletionTrigger
  action: ChapterCompletionAction
  cells: readonly WorkCell[]
  onAdvance: (key: string, subsectionKey?: string) => void
}): void {
  const t = useT()
  const onAdvanceRef = useRef(args.onAdvance)
  onAdvanceRef.current = args.onAdvance
  const nextRef = useRef(args.next)
  nextRef.current = args.next
  const identityRef = useRef<string | null>(null)
  const wasCompleteRef = useRef<boolean | null>(null)

  const complete = args.enabled
    && isChapterPageComplete({ cells: args.cells, trigger: args.trigger })
  const pageIdentity = `${args.fileId ?? ""}:${args.pageKey}:${args.subsectionKey ?? ""}`
  const nextKey = args.next
    ? `${args.next.key}:${args.next.subsectionKey ?? ""}`
    : ""

  useEffect(() => {
    const offerNext = (label: string) => {
      toast.add({
        id: CHAPTER_COMPLETE_TOAST_ID,
        type: "success",
        timeout: 0,
        title: t("editor.chapter.completeTitle", { label }),
        data: { pulse: false },
        actionProps: {
          children: t("editor.milestone.chapter.next"),
          onClick: () => {
            const destination = nextRef.current
            if (!destination) return
            onAdvanceRef.current(destination.key, destination.subsectionKey)
          },
        },
      })
    }

    if (!args.enabled || args.trigger === "manual" || args.action === "stay") {
      wasCompleteRef.current = null
      identityRef.current = null
      toast.close(CHAPTER_COMPLETE_TOAST_ID)
      return
    }

    // Rows haven't landed yet — don't treat an empty page as "incomplete"
    // or completing-on-hydrate will fire the trigger as a false rising edge.
    if (args.cells.length === 0) return

    const next = nextRef.current
    const isNewPage = identityRef.current !== pageIdentity
    if (isNewPage) {
      identityRef.current = pageIdentity
      wasCompleteRef.current = complete
      toast.close(CHAPTER_COMPLETE_TOAST_ID)
      return
    }

    if (!complete) {
      wasCompleteRef.current = false
      toast.close(CHAPTER_COMPLETE_TOAST_ID)
      return
    }

    if (wasCompleteRef.current) return
    wasCompleteRef.current = true
    if (!next) return

    if (args.action === "autoAdvance") {
      onAdvanceRef.current(next.key, next.subsectionKey)
      return
    }

    offerNext(args.currentLabel)
  }, [
    args.action,
    args.cells.length,
    args.currentLabel,
    args.enabled,
    args.trigger,
    complete,
    nextKey,
    pageIdentity,
    t,
  ])

  useEffect(() => () => {
    toast.close(CHAPTER_COMPLETE_TOAST_ID)
  }, [])
}
