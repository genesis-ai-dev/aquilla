// AQU-1722: "Generate voice" on the selection bar — pick ONE voice, speak
// every selected line in it.
//
// The dialog's job is to make the batch's scope and cost legible BEFORE it
// runs: how many lines will actually be spoken, which are skipped and why, how
// many words that is, and what it costs. Nothing here generates anything — it
// renders `planBatchVoice`'s plan and then runs exactly that plan.
//
// Progress is deliberately NOT drawn here. The run rides the shared batch
// queue, so the global AudioBulkProgressBanner ("Synthesizing 7/20", with
// Cancel) already shows it; the dialog closes on start and the one summary
// toast lands when the run ends. Two progress indicators for one queue is how
// a Cancel button ends up pointing at the wrong batch.

import { useEffect, useMemo, useState } from "react"
import { Sparkles } from "lucide-react"
import { toast } from "@/components/ui/toast"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { VoicePickerContent } from "@/components/voice/VoiceCombobox"
import { getVoiceLibrary, resolveVoice } from "@/lib/audio/voices"
import {
  hasGeneratedVoice,
  planBatchVoice,
  runBatchVoice,
  type BatchVoiceExisting,
  type BatchVoiceRunResult,
  type BatchVoiceSkipReason,
} from "@/lib/audio/batch-voice"
import { getOrgBilling } from "@/lib/sync/billing"
import { formatWordCount } from "@/lib/billing/plans"
import { formatCredits } from "@/lib/credits"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

/** How many line names a summary spells out before it counts the rest. */
const REFS_SHOWN = 6

const SKIP_LABEL: Record<BatchVoiceSkipReason, MessageKey> = {
  paratext: "audio.batchVoice.skipParatext",
  "no-text": "audio.batchVoice.skipNoText",
  "has-audio": "audio.batchVoice.skipHasAudio",
  "in-flight": "audio.batchVoice.skipInFlight",
  "over-allowance": "audio.batchVoice.skipOverAllowance",
  declined: "audio.batchVoice.skipDeclined",
}

/** Skip reasons in the order a reader cares about them. */
const SKIP_ORDER: readonly BatchVoiceSkipReason[] = [
  "over-allowance",
  "no-text",
  "has-audio",
  "in-flight",
  "paratext",
  "declined",
]

export interface BatchVoiceDialogProps {
  project: ProjectRecord
  /** The selected lines, in document order, merged with their audio. */
  cells: readonly CellData[]
  session: FrontierSession | null
  username: string
  /** AQU-1462: the lane being worked in. Omitted for the default lane. */
  targetLang?: string
  /**
   * Names a line the way the reader sees it (its reference, else the table's
   * # column). Supplied by the caller because only the editor knows the file's
   * numbering; every summary here goes through it so no message ever names a
   * line by its opaque id.
   */
  nameCell: (cell: CellData) => string
  onClose: () => void
}

export function BatchVoiceDialog({
  project,
  cells,
  session,
  username,
  targetLang,
  nameCell,
  onClose,
}: BatchVoiceDialogProps) {
  const t = useT()
  const { locale } = useI18n()
  const voices = useMemo(() => getVoiceLibrary(project.ttsSettings), [project.ttsSettings])
  const [voiceId, setVoiceId] = useState(() => resolveVoice(project.ttsSettings, undefined).id)
  const [existing, setExisting] = useState<BatchVoiceExisting>("skip")
  const [starting, setStarting] = useState(false)
  // The org's remaining word allowance, when this reader is allowed to see it
  // (maintainer+; the endpoint 403s otherwise and we treat that as unmetered).
  // Unmetered still shows the estimate — it just does not gate the run.
  const [remainingWords, setRemainingWords] = useState<number | null>(null)
  const [wordsPerCredit, setWordsPerCredit] = useState<number | undefined>(undefined)

  const orgId = project.orgId
  const jwt = session?.jwt
  useEffect(() => {
    if (!jwt || orgId == null) return
    let cancelled = false
    getOrgBilling(jwt, orgId)
      .then((b) => {
        if (cancelled || !b) return
        setRemainingWords(b.remainingWords)
        setWordsPerCredit(b.wordsPerCredit)
      })
      .catch(() => { /* unmetered view: the estimate still shows, the gate does not */ })
    return () => { cancelled = true }
  }, [jwt, orgId])

  const anyExistingAudio = useMemo(() => cells.some(hasGeneratedVoice), [cells])

  const plan = useMemo(
    () =>
      planBatchVoice({
        cells,
        existing,
        allowance: { remainingWords, ...(wordsPerCredit ? { wordsPerCredit } : {}) },
      }),
    [cells, existing, remainingWords, wordsPerCredit],
  )

  const nameOf = (cellId: string): string => {
    const cell = cells.find((c) => c.id === cellId)
    return cell ? nameCell(cell) : ""
  }

  const skipGroups = SKIP_ORDER.map((reason) => ({
    reason,
    ids: plan.skipped.filter((s) => s.reason === reason).map((s) => s.cellId),
  })).filter((g) => g.ids.length > 0)

  const onGenerate = async () => {
    if (plan.targets.length === 0 || starting) return
    setStarting(true)
    // Close first: the shared banner owns progress from here, and leaving a
    // modal over the editor would hide the very lines filling in behind it.
    onClose()
    let result: BatchVoiceRunResult
    try {
      result = await runBatchVoice({
        plan,
        project,
        session,
        username,
        voiceId,
        ...(targetLang ? { targetLang } : {}),
      })
    } catch (e) {
      toast.add({
        type: "error",
        title: t("audio.batchVoice.failedTitle"),
        description: e instanceof Error ? e.message : String(e),
      })
      return
    }
    reportRun(result, nameOf, t)
  }

  const voiceName = voices.find((v) => v.id === voiceId)?.name ?? ""

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("audio.batchVoice.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <section className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">
              {t("audio.batchVoice.voiceLabel")}
            </h3>
            <VoicePickerContent
              voices={voices}
              activeId={voiceId}
              onPick={setVoiceId}
              showLanguageBadge
            />
          </section>

          {anyExistingAudio && (
            <fieldset className="flex min-w-0 flex-col gap-1.5">
              <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
                {t("audio.batchVoice.existingLabel")}
              </legend>
              <RadioGroup
                value={existing}
                onValueChange={(v) => setExisting(v as BatchVoiceExisting)}
                className="flex flex-col gap-0.5"
                aria-label={t("audio.batchVoice.existingLabel")}
              >
                {(["skip", "overwrite"] as const).map((mode) => (
                  <label
                    key={mode}
                    className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50"
                  >
                    <RadioGroupItem
                      value={mode}
                      className="mt-0.5 shrink-0"
                      aria-label={t(
                        mode === "skip"
                          ? "audio.batchVoice.existingSkip"
                          : "audio.batchVoice.existingOverwrite",
                      )}
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-sm leading-tight font-medium">
                        {t(
                          mode === "skip"
                            ? "audio.batchVoice.existingSkip"
                            : "audio.batchVoice.existingOverwrite",
                        )}
                      </span>
                      <span className="text-xs leading-relaxed text-muted-foreground">
                        {t(
                          mode === "skip"
                            ? "audio.batchVoice.existingSkipHint"
                            : "audio.batchVoice.existingOverwriteHint",
                        )}
                      </span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </fieldset>
          )}

          <section className="flex min-w-0 flex-col gap-1 rounded-md border bg-muted/40 px-3 py-2">
            <p className="text-sm font-medium">
              {t("audio.batchVoice.estimate", {
                count: plan.targets.length,
                words: formatWordCount(plan.words),
                credits: formatCredits(plan.credits, locale),
              })}
            </p>
            {plan.exhausted ? (
              <p className="text-xs leading-relaxed text-destructive">
                {t("audio.batchVoice.allowanceExhausted")}
              </p>
            ) : plan.overAllowance > 0 ? (
              <p className="text-xs leading-relaxed text-destructive">
                {t("audio.batchVoice.allowancePartial", { count: plan.overAllowance })}
              </p>
            ) : null}
            {skipGroups.map((g) => (
              <p key={g.reason} className="text-xs leading-relaxed text-muted-foreground">
                {t(SKIP_LABEL[g.reason], { count: g.ids.length })}
                {summarizeRefs(g.ids.map(nameOf))}
              </p>
            ))}
          </section>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={starting}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={onGenerate} disabled={starting || plan.targets.length === 0}>
            {starting ? <Spinner className="me-1 size-3.5" /> : <Sparkles className="me-1 h-3.5 w-3.5" />}
            {t("audio.batchVoice.generate", { count: plan.targets.length, voice: voiceName })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * " — Luke 1:1, Luke 1:2 +4" appended to a count, so a skip clause names the
 * lines it is about rather than leaving the reader to find them.
 *
 * Returns an empty string when the caller could not name them (a file whose
 * headings carry neither a reference nor a row number) — a bare count is the
 * honest fallback; an opaque id would be worse than nothing.
 */
function summarizeRefs(refs: readonly string[]): string {
  const named = refs.filter((r) => r.trim().length > 0)
  if (named.length === 0) return ""
  const shown = named.slice(0, REFS_SHOWN).join(", ")
  return named.length > REFS_SHOWN ? ` — ${shown} +${named.length - REFS_SHOWN}` : ` — ${shown}`
}

/**
 * The run's one summary. AQU-344's lesson is the whole shape of this: a
 * failure names the LINE it happened on and the reason it happened, so there
 * is never a bare "audio failed" to act on.
 */
function reportRun(
  result: BatchVoiceRunResult,
  nameOf: (cellId: string) => string,
  t: ReturnType<typeof useT>,
): void {
  const parts: string[] = []
  if (result.failures.length > 0) {
    parts.push(
      ...result.failures.slice(0, REFS_SHOWN).map((f) => {
        const name = nameOf(f.cellId)
        return name ? `${name}: ${f.title}` : f.title
      }),
    )
    if (result.failures.length > REFS_SHOWN) {
      parts.push(t("audio.batchVoice.moreFailures", { count: result.failures.length - REFS_SHOWN }))
    }
  }
  if (result.stoppedAtCap) {
    parts.push(t("audio.batchVoice.stoppedAtCap", { count: result.notAttempted.length }))
  } else if (result.cancelled && result.notAttempted.length > 0) {
    parts.push(t("audio.batchVoice.cancelledRest", { count: result.notAttempted.length }))
  }
  if (result.skipped.length > 0) {
    parts.push(t("audio.batchVoice.skippedTotal", { count: result.skipped.length }))
  }

  const failed = result.failures.length > 0 || result.stoppedAtCap
  toast.add({
    type: failed ? "error" : "success",
    title: failed
      ? t("audio.batchVoice.partialTitle", { count: result.generated })
      : t("audio.batchVoice.doneTitle", { count: result.generated }),
    ...(parts.length > 0 ? { description: parts.join(" · ") } : {}),
  })
}
