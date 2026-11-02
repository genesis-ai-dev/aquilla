/**
 * Instructions pane (AQU-2342) — THE place the team writes how the AI should
 * translate this project. Every drafting path (the editor's copilot, Autopilot,
 * the agent) reads this one text, `settings.translationInstructions`.
 *
 * One auto-saving textarea, prefilled with the RESOLVED text: until a
 * maintainer edits it, that is the migrate-on-read composition of the old
 * sources (brief, a customized system prompt, instruction entries, the agent's
 * legacy brief). The first edit stores the field and the old sources stop
 * mattering. "Help me write this" opens the brief interview; its generated
 * summary is merged INTO this text rather than standing as a separate brief.
 *
 * The pane writes through the PAGE's useProjectSettings `patch` (the optimistic
 * overlay lives there) and must not fetch its own settings.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatCount } from "@/lib/i18n/format"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import { BriefBuilder } from "@/components/brief/BriefBuilder"
import { emptyBrief } from "@/lib/brief/brief"
import {
  draftField,
  extractBriefFromDocument,
  generateL1Summary,
} from "@/lib/brief/brief-generator"
import { useTranslationBrief } from "@/hooks/useTranslationBrief"
import { checkInputSize } from "@/lib/rules/rule-extractor"
import { resolveCompletionTarget } from "@/lib/completion/completion-service"
import { useUserProviderOverride } from "@/lib/store/user-provider-override"
import { TRANSLATION_INSTRUCTIONS_MAX_CHARS } from "@/lib/instructions/project-instructions"
import { INSTRUCTIONS_SAVE_DEBOUNCE_MS, mergeIntoInstructions } from "./instructions-merge"
import type { CannotEditReason, PatchOutcome } from "@/hooks/useProjectSettings"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"
import type { TranslationBrief } from "@/lib/brief/types"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { RoleLockTooltip } from "./RoleLockTooltip"

// Where the user configures an LLM. Only fires for a custom provider left
// incomplete — the Aquilla default always resolves (AQU-1671). The hint names
// the screen that owns the provider that failed to resolve.
const NO_PROVIDER_HINTS = {
  project: {
    endpoint: "Add an endpoint under Project settings → AI → AI model (advanced), or switch back to the default Aquilla provider.",
    apiKey: "Add the API key for your custom endpoint under Project settings → AI → AI model (advanced).",
  },
  "personal-override": {
    endpoint: "Your personal AI provider has no endpoint. Fix or clear it under Settings → Personal AI provider.",
    apiKey: "Your personal AI provider needs an API key. Add or clear it under Settings → Personal AI provider.",
  },
} as const
const ANSWERS_SAVED_NO_PROVIDER_TITLE = "Answers saved — no AI provider configured"
const GENERATE_FAILED_TITLE = "Couldn't write the instructions"

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type SaveStatus = "idle" | "saving" | "saved" | "error"

interface InstructionsPaneProps {
  /** The resolved instructions (stored, else migrated from the old sources). */
  resolved: string
  /** Page-level edit gate (MAINTAINER), already combined with readiness. */
  canEdit: boolean
  reasonCannotEdit: CannotEditReason
  /** The PAGE's useProjectSettings patch (optimistic overlay lives there). */
  patch: (partial: ProjectWideSettings) => Promise<PatchOutcome>
  /** The brief interview's stored answers (interview data only). */
  brief: TranslationBrief | undefined
  author: string
  /** `undefined` = never customized → the Aquilla default (AQU-1671). */
  completionSettings: CompletionSettings | undefined
  session: FrontierSession | null
}

export function InstructionsPane({
  resolved,
  canEdit,
  reasonCannotEdit,
  patch,
  brief,
  author,
  completionSettings,
  session,
}: InstructionsPaneProps) {
  const t = useT()
  const { locale } = useI18n()
  // `null` = untouched: the field tracks the resolved text (a late settings
  // GET updates it). The first keystroke pins the draft so later reads can't
  // clobber an edit in progress.
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? resolved
  const [status, setStatus] = useState<SaveStatus>("idle")
  const [helpOpen, setHelpOpen] = useState(false)

  const patchRef = useRef(patch)
  const draftRef = useRef<string | null>(null)
  const lastSavedRef = useRef<string | null>(null)
  useEffect(() => {
    patchRef.current = patch
    draftRef.current = draft
  })

  const save = useCallback(async (text: string) => {
    if (text === lastSavedRef.current) return
    lastSavedRef.current = text
    setStatus("saving")
    const outcome = await patchRef.current({ translationInstructions: text })
    if (outcome.kind === "ok") {
      setStatus("saved")
    } else {
      // Keep the draft so the edit survives; a later keystroke retries.
      lastSavedRef.current = null
      setStatus("error")
    }
  }, [])

  // Debounced auto-save of the pinned draft.
  useEffect(() => {
    if (draft === null || !canEdit) return
    const timer = setTimeout(() => void save(draft), INSTRUCTIONS_SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft, canEdit, save])

  // Leaving the pane mid-debounce must not drop the last keystrokes.
  useEffect(
    () => () => {
      const pending = draftRef.current
      if (pending !== null && pending !== lastSavedRef.current) {
        void patchRef.current({ translationInstructions: pending })
      }
    },
    [],
  )

  // "Project settings else the Aquilla default" — the precedence every other
  // LLM call site applies (AQU-1671).
  const providerOverride = useUserProviderOverride()
  const { settings: aiSettings, configured: aiConfigured, gap: aiGap, source: aiSource } =
    resolveCompletionTarget(completionSettings, providerOverride)
  const { save: saveBrief, attachL1 } = useTranslationBrief({ brief, author, patch })

  /** The interview's last step: summarize the answers into the field. */
  async function writeFromInterview(answers: Parameters<typeof saveBrief>[1]): Promise<boolean> {
    // The answers always save, even with no provider (AQU-968).
    const saved = await saveBrief(brief ?? emptyBrief(author), answers)
    if (!aiConfigured) {
      toast.add({
        type: "warning",
        title: ANSWERS_SAVED_NO_PROVIDER_TITLE,
        description: NO_PROVIDER_HINTS[aiSource][aiGap ?? "endpoint"],
      })
      return false
    }
    try {
      const summary = await generateL1Summary(saved, aiSettings, session)
      await attachL1(saved, summary, aiSettings.model)
      const merged = mergeIntoInstructions(value, summary)
      if (merged !== value) {
        setDraft(merged)
        await save(merged)
      }
      return true
    } catch (err) {
      toast.add({ type: "error", title: GENERATE_FAILED_TITLE, description: errMessage(err) })
      return false
    }
  }

  const title = t("terminology.livingMemory.instructionsTitle")
  const statusText =
    status === "saving"
      ? t("common.saving")
      : status === "saved"
        ? t("common.saved")
        : status === "error"
          ? t("terminology.livingMemory.instructions.saveFailed")
          : null

  return (
    <section aria-labelledby="living-memory-instructions-heading" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 id="living-memory-instructions-heading" className="text-sm font-semibold">
            {title}
          </h2>
          {!canEdit && <RoleLockTooltip reason={reasonCannotEdit} />}
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t("terminology.livingMemory.section.instructions.description")}
        </p>
      </div>

      <Textarea
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && canEdit) void save(draft)
        }}
        readOnly={!canEdit}
        maxLength={TRANSLATION_INSTRUCTIONS_MAX_CHARS}
        aria-label={title}
        placeholder={t("terminology.livingMemory.instructions.placeholder")}
        className="min-h-[320px] resize-y leading-relaxed"
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {canEdit ? (
          <Button variant="outline" size="sm" onClick={() => setHelpOpen(true)}>
            {t("agent.brief.helpMeWrite")}
          </Button>
        ) : (
          <span>
            {reasonCannotEdit === "offline"
              ? t("terminology.livingMemory.offlineTooltip")
              : t("terminology.livingMemory.maintainerRequiredTooltip")}
          </span>
        )}
        <div className="flex-1" />
        {statusText && (
          <span role={status === "error" ? "alert" : "status"} className={status === "error" ? "text-destructive" : undefined}>
            {statusText}
          </span>
        )}
        <span className="tabular-nums">
          {t("terminology.livingMemory.instructions.charCount", {
            count: formatCount(value.length, locale),
            max: formatCount(TRANSLATION_INSTRUCTIONS_MAX_CHARS, locale),
          })}
        </span>
      </div>

      {helpOpen && (
        <BriefBuilder
          open={helpOpen}
          brief={brief ?? emptyBrief(author)}
          canEdit={canEdit}
          title={t("terminology.livingMemory.instructions.helpTitle")}
          finishLabel={t("terminology.livingMemory.instructions.helpFinish")}
          onClose={() => setHelpOpen(false)}
          onSaveDraft={(answers) => saveBrief(brief ?? emptyBrief(author), answers)}
          onGenerateL1={writeFromInterview}
          onHelpDraft={aiConfigured
            ? (fieldId, answers) => draftField(fieldId, answers, aiSettings, session)
            : undefined
          }
          onExtractDocument={aiConfigured
            ? async (text) => {
                const chk = checkInputSize(text)
                if (!chk.ok) throw new Error(chk.message)
                return extractBriefFromDocument(text, aiSettings, session)
              }
            : undefined
          }
        />
      )}
    </section>
  )
}
