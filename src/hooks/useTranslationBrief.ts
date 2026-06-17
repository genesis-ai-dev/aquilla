// src/hooks/useTranslationBrief.ts
import { useCallback } from "react"
import { assembleL2Markdown } from "@/lib/brief/brief"
import type { TranslationBrief } from "@/lib/brief/types"

export interface BriefDraft {
  parameters: Record<string, string>
  freeformNotes: string
}

/** Pure: produce the next persisted brief from a draft (bump version, restamp,
 *  reassemble L2). Does NOT touch L1 — generation is a separate explicit step. */
export function buildSavePayload(
  prev: TranslationBrief,
  draft: BriefDraft,
  author: string,
): TranslationBrief {
  const next: TranslationBrief = {
    ...prev,
    version: prev.version + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: author,
    parameters: { ...draft.parameters },
    freeformNotes: draft.freeformNotes,
    l2Markdown: "",
  }
  next.l2Markdown = assembleL2Markdown(next)
  return next
}

/** Pure: attach a freshly generated L1, stamping l1GeneratedAt === updatedAt so
 *  isL1Stale() reports fresh until the next content edit. */
export function withGeneratedL1(
  brief: TranslationBrief,
  l1Summary: string,
  modelId: string,
): TranslationBrief {
  return { ...brief, l1Summary, l1ModelId: modelId, l1GeneratedAt: brief.updatedAt }
}

/** Thin controller: returns save/generate callbacks bound to the project's
 *  settings patch fn. `patch` is `useProjectSettings(...).patch`. */
export function useTranslationBrief(opts: {
  brief: TranslationBrief | undefined
  author: string
  patch: (partial: { translationBrief: TranslationBrief }) => Promise<unknown>
}) {
  const { brief, author, patch } = opts

  const save = useCallback(
    async (prev: TranslationBrief, draft: BriefDraft) => {
      const next = buildSavePayload(prev, draft, author)
      await patch({ translationBrief: next })
      return next
    },
    [author, patch],
  )

  const attachL1 = useCallback(
    async (saved: TranslationBrief, l1Summary: string, modelId: string) => {
      const next = withGeneratedL1(saved, l1Summary, modelId)
      await patch({ translationBrief: next })
      return next
    },
    [patch],
  )

  return { brief, save, attachL1 }
}
