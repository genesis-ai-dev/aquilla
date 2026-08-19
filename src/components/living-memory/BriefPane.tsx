/**
 * Brief pane — the project's translation brief (BriefSection summary card +
 * BriefBuilder modal) with L1 generation / document extraction wired to the
 * page-level useProjectSettings `patch` (the pane must NOT fetch its own
 * settings — the page's hook instance carries the optimistic overlay).
 */

import { useState } from "react"
import { BriefSection } from "@/components/brief/BriefSection"
import { BriefBuilder } from "@/components/brief/BriefBuilder"
import { emptyBrief, isL1Stale } from "@/lib/brief/brief"
import { useTranslationBrief } from "@/hooks/useTranslationBrief"
import {
  generateL1Summary,
  extractBriefFromDocument,
  draftField,
} from "@/lib/brief/brief-generator"
import { checkInputSize } from "@/lib/rules/rule-extractor"
import type { TranslationBrief } from "@/lib/brief/types"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

interface BriefPaneProps {
  brief: TranslationBrief | undefined
  /** Page-level edit gate, already combined with `entriesReady`. */
  canEdit: boolean
  author: string
  /** From the overlaid project record; undefined = no LLM configured, so
   *  generation affordances fall back to opening the builder. */
  completionSettings: CompletionSettings | undefined
  session: FrontierSession | null
  /** The PAGE's useProjectSettings patch (optimistic overlay lives there). */
  patch: (partial: { translationBrief: TranslationBrief }) => Promise<unknown>
}

export function BriefPane({
  brief,
  canEdit,
  author,
  completionSettings,
  session,
  patch,
}: BriefPaneProps) {
  const stale = brief ? isL1Stale(brief) : false
  const [builderOpen, setBuilderOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const { save: saveBrief, attachL1 } = useTranslationBrief({ brief, author, patch })

  async function handleGenerate() {
    // Edit gate (defense-in-depth; the server + patch() also enforce MAINTAINER).
    if (!canEdit) return
    // No brief yet, or no LLM configured → fall back to opening the builder.
    if (!brief || !completionSettings) {
      setBuilderOpen(true)
      return
    }
    // Lock the section's edit/generate affordances while the LLM call is in
    // flight so a concurrent open-and-save can't clobber the brief object we
    // re-persist in attachL1 (adversarial review: races lens, finding 2).
    setGenerating(true)
    try {
      const l1 = await generateL1Summary(brief, completionSettings, session ?? null)
      await attachL1(brief, l1, completionSettings.model)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <>
      <BriefSection
        brief={brief}
        canEdit={canEdit}
        stale={stale}
        busy={generating}
        onEdit={() => setBuilderOpen(true)}
        onGenerate={handleGenerate}
      />

      {builderOpen && (
        <BriefBuilder
          open={builderOpen}
          brief={brief ?? emptyBrief(author)}
          canEdit={canEdit}
          onClose={() => setBuilderOpen(false)}
          onSaveDraft={async (draft) => {
            const prev = brief ?? emptyBrief(author)
            return saveBrief(prev, draft)
          }}
          onGenerateL1={async (draft) => {
            if (!completionSettings) return
            const prev = brief ?? emptyBrief(author)
            const saved = await saveBrief(prev, draft)
            const l1 = await generateL1Summary(saved, completionSettings, session ?? null)
            await attachL1(saved, l1, completionSettings.model)
          }}
          onHelpDraft={completionSettings
            ? (fieldId, draft) => draftField(fieldId, draft, completionSettings, session ?? null)
            : undefined
          }
          onExtractDocument={completionSettings
            ? async (text) => {
                const chk = checkInputSize(text)
                if (!chk.ok) throw new Error(chk.message)
                return extractBriefFromDocument(text, completionSettings, session ?? null)
              }
            : undefined
          }
        />
      )}
    </>
  )
}
