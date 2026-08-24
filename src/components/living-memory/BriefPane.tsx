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
import { toast } from "@/components/ui/toast"
import type { TranslationBrief } from "@/lib/brief/types"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

// Where the user configures an LLM. Named in the no-provider affordances so
// "nothing happened" reads as "nothing is configured yet", not "it's broken".
const NO_PROVIDER_HINT =
  "Add one under Project Settings → AI & completion to generate a summary."
const NO_PROVIDER_TITLE = "No AI provider configured"
const DRAFT_SAVED_NO_PROVIDER_TITLE = "Brief saved — no AI provider configured"
const GENERATE_FAILED_TITLE = "Couldn't generate summary"

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface BriefPaneProps {
  brief: TranslationBrief | undefined
  /** Page-level edit gate, already combined with `entriesReady`. */
  canEdit: boolean
  author: string
  /** From the overlaid project record; undefined = no LLM configured, so
   *  generation affordances surface an actionable "add a provider" toast
   *  instead of silently no-op'ing (AQU-968). */
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
    // No brief yet → open the builder to capture one first.
    if (!brief) {
      setBuilderOpen(true)
      return
    }
    // Brief exists but no LLM configured → say what's missing and how to fix
    // it, instead of silently reopening the builder (which reads as a
    // malfunction rather than a fallback). AQU-968.
    if (!completionSettings) {
      toast.add({ type: "warning", title: NO_PROVIDER_TITLE, description: NO_PROVIDER_HINT })
      return
    }
    // Lock the section's edit/generate affordances while the LLM call is in
    // flight so a concurrent open-and-save can't clobber the brief object we
    // re-persist in attachL1 (adversarial review: races lens, finding 2).
    setGenerating(true)
    try {
      const l1 = await generateL1Summary(brief, completionSettings, session ?? null)
      await attachL1(brief, l1, completionSettings.model)
    } catch (err) {
      // Surface LLM failures instead of stalling silently. AQU-968.
      toast.add({ type: "error", title: GENERATE_FAILED_TITLE, description: errMessage(err) })
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
            // Always persist the draft first — even with no provider the brief
            // must save (AQU-968). Return value tells the builder whether a
            // summary was actually generated (→ it may close).
            const prev = brief ?? emptyBrief(author)
            const saved = await saveBrief(prev, draft)
            if (!completionSettings) {
              toast.add({
                type: "warning",
                title: DRAFT_SAVED_NO_PROVIDER_TITLE,
                description: NO_PROVIDER_HINT,
              })
              return false
            }
            try {
              const l1 = await generateL1Summary(saved, completionSettings, session ?? null)
              await attachL1(saved, l1, completionSettings.model)
              return true
            } catch (err) {
              toast.add({ type: "error", title: GENERATE_FAILED_TITLE, description: errMessage(err) })
              return false
            }
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
