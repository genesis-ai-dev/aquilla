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
 *
 * Every save names the stored value the edit started from (`expect`). The
 * server appends to this same text on its own — answering an Autopilot
 * decision card, approving an agent decision — so a save over a newer stored
 * text is refused instead of erasing that line. The box keeps the person's
 * text and offers "Load latest" or "Save mine anyway"; nothing auto-saves
 * until they choose.
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
import type { CannotEditReason, PatchOptions, PatchOutcome } from "@/hooks/useProjectSettings"
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
  /** The STORED `translationInstructions` (undefined = never written): what a
   *  save expects to still be there. */
  stored: string | undefined
  /** Page-level edit gate (MAINTAINER), already combined with readiness. */
  canEdit: boolean
  reasonCannotEdit: CannotEditReason
  /** The PAGE's useProjectSettings patch (optimistic overlay lives there). */
  patch: (partial: ProjectWideSettings, opts?: PatchOptions) => Promise<PatchOutcome>
  /** The brief interview's stored answers (interview data only). */
  brief: TranslationBrief | undefined
  author: string
  /** `undefined` = never customized → the Aquilla default (AQU-1671). */
  completionSettings: CompletionSettings | undefined
  session: FrontierSession | null
}

export function InstructionsPane({
  resolved,
  stored,
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
  // A save was refused because the stored text changed under the edit.
  const [conflict, setConflict] = useState(false)

  const patchRef = useRef(patch)
  const tRef = useRef(t)
  const draftRef = useRef<string | null>(null)
  const lastSavedRef = useRef<string | null>(null)
  const storedRef = useRef(stored)
  const conflictRef = useRef(false)
  // The stored text this edit started from (set when the draft is pinned,
  // moved on by each save that lands). `null` = no edit in progress.
  const baseRef = useRef<{ value: string | undefined } | null>(null)
  // What the server held when a save was refused: "Save mine anyway" expects it.
  const latestRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    patchRef.current = patch
    tRef.current = t
    draftRef.current = draft
    storedRef.current = stored
  })

  /** Pin the draft; the first pin remembers the stored text it started from. */
  const edit = (text: string) => {
    if (draft === null) baseRef.current = { value: stored }
    setDraft(text)
  }

  const write = (text: string) =>
    patchRef.current(
      { translationInstructions: text },
      { expect: [{ key: "translationInstructions", value: (baseRef.current ?? { value: storedRef.current }).value }] },
    )

  const save = useCallback(async (text: string) => {
    if (conflictRef.current || text === lastSavedRef.current) return
    lastSavedRef.current = text
    setStatus("saving")
    const outcome = await write(text)
    if (outcome.kind === "ok") {
      baseRef.current = { value: text }
      setStatus("saved")
    } else if (outcome.kind === "conflict") {
      // Someone else's text is stored now. Keep ours in the box, write nothing
      // more until the person picks one.
      lastSavedRef.current = null
      latestRef.current = outcome.latest.settings.translationInstructions
      conflictRef.current = true
      setConflict(true)
      setStatus("idle")
    } else {
      // Keep the draft so the edit survives; a later keystroke retries.
      lastSavedRef.current = null
      setStatus("error")
    }
    // write reads everything through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Drop the unsaved text and show what is stored now. */
  const loadLatest = () => {
    conflictRef.current = false
    baseRef.current = null
    lastSavedRef.current = null
    setConflict(false)
    setStatus("idle")
    setDraft(null)
  }

  /** Save the person's text over the newer stored one, knowingly. */
  const overwrite = () => {
    if (draft === null) return
    conflictRef.current = false
    baseRef.current = { value: latestRef.current }
    setConflict(false)
    void save(draft)
  }

  // Debounced auto-save of the pinned draft.
  useEffect(() => {
    if (draft === null || !canEdit || conflict) return
    const timer = setTimeout(() => void save(draft), INSTRUCTIONS_SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft, canEdit, conflict, save])

  // Leaving the pane mid-debounce must not drop the last keystrokes — unless
  // the stored text moved on, which this write must not erase either.
  useEffect(
    () => () => {
      const pending = draftRef.current
      if (pending === null || pending === lastSavedRef.current) return
      if (conflictRef.current) {
        toast.add({ type: "warning", title: tRef.current("terminology.livingMemory.instructions.notSavedOnLeave") })
        return
      }
      void write(pending).then((outcome) => {
        if (outcome.kind === "conflict") {
          toast.add({ type: "warning", title: tRef.current("terminology.livingMemory.instructions.notSavedOnLeave") })
        }
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        edit(merged)
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
        onChange={(e) => edit(e.target.value)}
        onBlur={() => {
          if (draft !== null && canEdit && !conflict) void save(draft)
        }}
        readOnly={!canEdit}
        maxLength={TRANSLATION_INSTRUCTIONS_MAX_CHARS}
        aria-label={title}
        placeholder={t("terminology.livingMemory.instructions.placeholder")}
        className="min-h-[320px] resize-y leading-relaxed"
      />

      {conflict && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs"
        >
          <p>{t("terminology.livingMemory.instructions.conflict")}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={loadLatest}>
              {t("terminology.livingMemory.instructions.loadLatest")}
            </Button>
            <Button variant="ghost" size="sm" onClick={overwrite}>
              {t("terminology.livingMemory.instructions.overwrite")}
            </Button>
          </div>
        </div>
      )}

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
