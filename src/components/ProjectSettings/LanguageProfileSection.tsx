// "Language profile for checks" card (AQU-1688), under Settings → General →
// Languages, where the rest of the project's language settings live.
//
// It records facts about the target language that Bible data checks need.
// Today that is one slot, the quotation marks by level; AQU-1691 adds more.
// A check whose slot is empty is dormant, and Rules → Built-in checks says so.
//
// Like LanguagesSection, it saves through the page's shared-settings `patch`
// itself (conflict, role and offline handling live in that hook) rather than
// joining the page's deferred Save bar. The slot is merged over the stored
// profile, so saving it never wipes another slot.

import { useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SettingsBlock, SettingsGroup, SettingsRow } from "@/components/ui/page"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { PatchOutcome } from "@/hooks/useProjectSettings"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"
import { defaultQuoteMarks } from "@/lib/bible-data/quote-mark-defaults"
import { draftFromQuoteMarks, quoteMarksFromDraft, type QuoteMarksDraft } from "@/lib/bible-data/quote-marks-draft"
import {
  QUOTE_CONTINUATION_STYLES,
  readLanguageProfile,
  type LanguageProfile,
  type QuoteContinuationStyle,
} from "../../../db/shared/language-profile"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"

const LEVEL_KEYS: readonly MessageKey[] = [
  "bibleData.profile.quoteMarks.level1",
  "bibleData.profile.quoteMarks.level2",
  "bibleData.profile.quoteMarks.level3",
]

const CONTINUATION_KEYS: Readonly<Record<QuoteContinuationStyle, MessageKey>> = {
  "reopen-each-paragraph": "bibleData.profile.continuation.reopenEachParagraph",
  "continuation-mark": "bibleData.profile.continuation.continuationMark",
  none: "bibleData.profile.continuation.none",
}

export interface LanguageProfileSectionProps {
  /** The stored `languageProfile` (the shared settings blob's value). */
  value: LanguageProfile | undefined
  /** The project's target language, for "Use defaults for …". */
  targetLanguage: string
  /** Mirrors the server's maintainer floor for the settings PATCH. */
  canEdit: boolean
  /** Why the controls are locked (role or offline), or null. */
  disabledTooltip: ReactNode
  patch: (partial: ProjectWideSettings) => Promise<PatchOutcome>
}

function outcomeError(outcome: PatchOutcome, t: TFunction): string | null {
  if (outcome.kind === "ok") return null
  if (outcome.kind === "conflict") return t("bibleData.profile.error.conflict")
  if (outcome.kind === "blocked") {
    return outcome.reason === "offline" ? t("bibleData.profile.error.offline") : t("bibleData.profile.error.permission")
  }
  return t("bibleData.profile.error.failed")
}

export function LanguageProfileSection({ value, targetLanguage, canEdit, disabledTooltip, patch }: LanguageProfileSectionProps) {
  const t = useT()
  const format = useFormat()
  const profile = readLanguageProfile(value)
  const stored = profile.quoteMarks
  const storedKey = JSON.stringify(stored ?? null)
  const [draft, setDraft] = useState<QuoteMarksDraft>(() => draftFromQuoteMarks(stored))
  const [syncedKey, setSyncedKey] = useState(storedKey)
  const [status, setStatus] = useState<{ kind: "saved" } | { kind: "error"; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  // A save here or elsewhere changed the stored slot: show what is stored now.
  if (syncedKey !== storedKey) {
    setSyncedKey(storedKey)
    setDraft(draftFromQuoteMarks(stored))
  }
  const defaults = defaultQuoteMarks(targetLanguage)
  const disabled = !canEdit || saving

  const setMark = (level: number, side: "open" | "close", mark: string) => {
    setStatus(null)
    setDraft((prev) => ({
      ...prev,
      levels: prev.levels.map((row, i) => (i === level ? { ...row, [side]: mark } : row)),
    }))
  }

  async function save(next: LanguageProfile) {
    setSaving(true)
    try {
      const error = outcomeError(await patch({ languageProfile: next }), t)
      setStatus(error ? { kind: "error", message: error } : { kind: "saved" })
    } finally {
      setSaving(false)
    }
  }

  // Merge over the stored object as it is, not over what this client can read:
  // a slot added by a newer version (AQU-1691) must survive a save from here.
  const storedRaw: LanguageProfile =
    typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}

  function handleSave() {
    const quoteMarks = quoteMarksFromDraft(draft)
    if (!quoteMarks) {
      setStatus({ kind: "error", message: t("bibleData.profile.invalid") })
      return
    }
    void save({ ...storedRaw, quoteMarks })
  }

  function handleClear() {
    const { quoteMarks: _cleared, ...rest } = storedRaw
    void save(rest)
  }

  return (
    <SettingsGroup label={t("bibleData.profile.title")} description={t("bibleData.profile.description")}>
      <SettingsRow
        block
        label={t("bibleData.profile.quoteMarks.label")}
        description={t("bibleData.profile.quoteMarks.description")}
      >
        <DisabledFieldTooltip disabled={!canEdit} tooltip={disabledTooltip}>
          <div className="grid max-w-sm grid-cols-[1fr_auto_auto] items-center gap-2" data-testid="language-profile-marks">
            {draft.levels.map((row, level) => {
              const levelName = t(LEVEL_KEYS[level])
              return [
                <span key={`label-${level}`} className="text-sm">{levelName}</span>,
                <Input
                  key={`open-${level}`}
                  value={row.open}
                  onChange={(e) => setMark(level, "open", e.target.value)}
                  disabled={disabled}
                  aria-label={t("bibleData.profile.quoteMarks.openAriaLabel", { level: levelName })}
                  className="w-12 bg-background text-center text-lg md:text-lg"
                  maxLength={2}
                />,
                <Input
                  key={`close-${level}`}
                  value={row.close}
                  onChange={(e) => setMark(level, "close", e.target.value)}
                  disabled={disabled}
                  aria-label={t("bibleData.profile.quoteMarks.closeAriaLabel", { level: levelName })}
                  className="w-12 bg-background text-center text-lg md:text-lg"
                  maxLength={2}
                />,
              ]
            })}
          </div>
        </DisabledFieldTooltip>
      </SettingsRow>
      <SettingsRow
        label={<label htmlFor="language-profile-continuation">{t("bibleData.profile.continuation.label")}</label>}
        control={
          <DisabledFieldTooltip disabled={!canEdit} tooltip={disabledTooltip}>
            <Select
              items={QUOTE_CONTINUATION_STYLES.map((style) => ({ value: style, label: t(CONTINUATION_KEYS[style]) }))}
              disabled={disabled}
              value={draft.continuation}
              onValueChange={(style) => {
                setStatus(null)
                setDraft((prev) => ({ ...prev, continuation: (style ?? prev.continuation) as QuoteContinuationStyle }))
              }}
            >
              <SelectTrigger
                id="language-profile-continuation"
                aria-label={t("bibleData.profile.continuation.label")}
                className="w-64 max-w-full bg-background"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {QUOTE_CONTINUATION_STYLES.map((style) => (
                    <SelectItem key={style} value={style}>{t(CONTINUATION_KEYS[style])}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </DisabledFieldTooltip>
        }
      />
      <SettingsBlock className="flex flex-wrap items-center gap-2">
        {defaults ? (
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setStatus(null)
              setDraft(draftFromQuoteMarks(defaults))
            }}
          >
            {t("bibleData.profile.useDefaults", { language: format.isolate(targetLanguage) })}
          </Button>
        ) : null}
        <Button type="button" disabled={disabled} onClick={handleSave}>
          {t("bibleData.profile.save")}
        </Button>
        {stored ? (
          <Button type="button" variant="ghost" disabled={disabled} onClick={handleClear}>
            {t("bibleData.profile.clear")}
          </Button>
        ) : null}
      </SettingsBlock>
      <SettingsBlock>
        <p
          role={status?.kind === "error" ? "alert" : "status"}
          className={status?.kind === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
        >
          {status?.kind === "error"
            ? status.message
            : status?.kind === "saved"
              ? t("bibleData.profile.saved")
              : !stored
                ? t("bibleData.profile.notSet")
                : null}
        </p>
      </SettingsBlock>
    </SettingsGroup>
  )
}
