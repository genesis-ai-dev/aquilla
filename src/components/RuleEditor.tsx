/**
 * RuleEditor — plain-language rule editor (AQU-195).
 *
 * Used for BOTH create and edit. Create opens in a dialog from RulesSurface;
 * edit remains inline under the rule row.
 * Features:
 *  - Plain-language sentence that updates live as fields change
 *  - Side + Mode pickers → maps to RuleCheck union
 *  - Pattern input with regex/literal toggle + inline validation
 *  - Severity + enabled
 *  - Optional autofix (regex-replace) with before/after preview
 *  - Live preview: runs draft rule against provided cells, shows match count + sample
 *  - Debounced pattern evaluation so typing stays smooth
 */
import { useState, useMemo, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { LaneCombobox } from "@/components/LaneCombobox"
import { ChevronDown, X } from "lucide-react"
import type { TranslationRule, RuleCheck, RuleAutofix } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
import posthog from "@/lib/posthog"
import { cn } from "@/lib/utils"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { t as standaloneT } from "@/lib/i18n/standalone"

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Escape a literal string so it is safe inside a RegExp. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Validate a regex string. Returns null if valid, error message if invalid.
 * `new RegExp()`'s own message is a JS engine error (content, not chrome) and
 * is passed through verbatim; only the "couldn't even tell you why" fallback
 * is app copy. Standalone `t()`: called directly in RuleEditor.test.ts with no
 * provider/component in scope.
 *
 * `flags` is optional so the autofix editor can reject a bad flag string
 * ("gg", "gx") the same way it rejects a bad pattern — `new RegExp()` throws on
 * either, and an autofix is stored as pattern + flags together.
 */
export function validateRegex(pattern: string, flags?: string): string | null {
  if (!pattern) return null
  try {
    new RegExp(pattern, flags)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : standaloneT("rules.editor.invalidRegexFallback")
  }
}

type Side = "source" | "target"
type Mode = "required" | "forbidden" | "match"

/**
 * The `side` values a mode can actually express as a `RuleCheck`.
 *
 * There is no source-side prohibition in the union: `target-forbids` constrains
 * the target, and `source-requires-target` also constrains the target (its
 * source pattern only decides *when* the rule applies). `match` covers both
 * sides at once, so it shows no side picker at all.
 *
 * Offering "source" for `forbidden`/`required` was a dead end — `buildCheck`
 * returned `null`, so Save failed with "Pattern is required" even though the
 * pattern was filled, while the plain-language sentence claimed the rule
 * applied to the source.
 */
export function sidesForMode(mode: Mode): Side[] {
  return mode === "match" ? ["source", "target"] : ["target"]
}

function buildCheck(
  side: Side,
  mode: Mode,
  patternRaw: string,
  isLiteral: boolean,
  sourcePatternRaw: string,
): RuleCheck | null {
  const toPattern = (s: string) => isLiteral ? escapeRegex(s) : s
  const pat = toPattern(patternRaw)
  const srcPat = toPattern(sourcePatternRaw)

  if (mode === "forbidden" && side === "target") {
    if (!pat) return null
    return { type: "target-forbids", targetPattern: pat }
  }
  if (mode === "required" && side === "target") {
    // source-requires-target: when source matches srcPat, target must contain pat
    if (!srcPat || !pat) return null
    return { type: "source-requires-target", sourcePattern: srcPat, targetPattern: pat }
  }
  if (mode === "match") {
    // source-target-match: pattern must be present in both
    if (!pat) return null
    return { type: "source-target-match", pattern: pat }
  }
  return null
}

function humanSentence(side: Side, mode: Mode, t: TFunction): string {
  if (mode === "forbidden") {
    return side === "source"
      ? t("rules.editor.sentence.forbiddenSource")
      : t("rules.editor.sentence.forbiddenTarget")
  }
  if (mode === "required") return t("rules.editor.sentence.required")
  if (mode === "match") return t("rules.editor.sentence.match")
  return ""
}

// ─── Live preview ─────────────────────────────────────────────────────────────

function usePreview(draftCheck: RuleCheck | null, cells: CellData[]) {
  return useMemo(() => {
    if (!draftCheck || cells.length === 0) return { count: 0, samples: [] as CellData[] }
    const draftRule: TranslationRule = {
      id: "preview",
      name: "Preview",
      description: "",
      severity: "minor",
      source: "user",
      scope: "project",
      check: draftCheck,
      enabled: true,
      createdAt: new Date().toISOString(),
    }
    const matches: CellData[] = []
    for (const cell of cells) {
      const infractions = checkRulesForCell(cell, "preview-file", [draftRule])
      if (infractions.length > 0) matches.push(cell)
      if (matches.length >= 3) break
    }
    return { count: matches.length, samples: matches }
  }, [draftCheck, cells])
}

// ─── Component ────────────────────────────────────────────────────────────────

interface RuleEditorProps {
  /** Pass existing rule to populate (edit mode). Omit for create mode. */
  initialRule?: TranslationRule
  cells: CellData[]
  onSave: (rule: Omit<TranslationRule, "id" | "createdAt">) => void
  onCancel: () => void
  /** Optional class override for the outer shell (e.g. dialog embed). */
  className?: string
  /**
   * AQU-609: the project's NAMED target-language lanes (excluding `''`). When
   * non-empty, an "Applies to" picker offers project scope ("All lanes"), the
   * default lane, or one named lane. Omit for org-rule editors and single-lane
   * projects — the rule then keeps its existing scope (or `project` on create).
   */
  lanes?: string[]
  /** Display label for the default (`''`) lane, e.g. the project's base
   *  target language. Falls back to a generic string. */
  defaultLaneLabel?: string
  /** Display names keyed by lane tag. The stored value stays the tag. */
  laneLabels?: Readonly<Record<string, string>>
}

export function RuleEditor({ initialRule, cells, onSave, onCancel, className, lanes, defaultLaneLabel, laneLabels }: RuleEditorProps) {
  const t = useT()
  // ── Field state ──
  const [name, setName] = useState(initialRule?.name ?? "")
  const [description, setDescription] = useState(initialRule?.description ?? "")
  const [severity, setSeverity] = useState<"major" | "minor">(initialRule?.severity ?? "minor")
  const [enabled, setEnabled] = useState(initialRule?.enabled ?? true)
  // AQU-609: `null` = every lane (project scope); a string = that lane only
  // (`''` is the default lane, per the AQU-538 convention).
  const [laneChoice, setLaneChoice] = useState<string | null>(() =>
    initialRule?.scope === "lane" ? initialRule.lane ?? "" : null,
  )
  const showLanePicker = (lanes?.length ?? 0) > 0

  // Decode existing check into side/mode/pattern
  const [side, setSide] = useState<Side>(() => {
    const c = initialRule?.check
    if (!c) return "target"
    if (c.type === "target-forbids") return "target"
    if (c.type === "source-requires-target") return "target"
    return "source"
  })
  const [mode, setMode] = useState<Mode>(() => {
    const c = initialRule?.check
    if (!c) return "forbidden"
    if (c.type === "target-forbids") return "forbidden"
    if (c.type === "source-requires-target") return "required"
    if (c.type === "source-target-match") return "match"
    return "forbidden"
  })
  const [isLiteral, setIsLiteral] = useState(false)
  const [pattern, setPattern] = useState(() => {
    const c = initialRule?.check
    if (!c) return ""
    if (c.type === "target-forbids") return c.targetPattern
    if (c.type === "source-requires-target") return c.targetPattern
    if (c.type === "source-target-match") return c.pattern
    return ""
  })
  const [sourcePattern, setSourcePattern] = useState(() => {
    const c = initialRule?.check
    if (c?.type === "source-requires-target") return c.sourcePattern
    return ""
  })

  // Autofix fields
  const [showAutofix, setShowAutofix] = useState(!!initialRule?.autofix)
  const [afPattern, setAfPattern] = useState(initialRule?.autofix?.pattern ?? "")
  const [afReplacement, setAfReplacement] = useState(initialRule?.autofix?.replacement ?? "")
  const [afFlags, setAfFlags] = useState(initialRule?.autofix?.flags ?? "gi")
  const [afSample, setAfSample] = useState("")

  // ── Validation ──
  const patternError = useMemo(() => isLiteral ? null : validateRegex(pattern), [pattern, isLiteral])
  const sourcePatternError = useMemo(() => isLiteral ? null : validateRegex(sourcePattern), [sourcePattern, isLiteral])
  // The autofix is always a regex (there is no literal toggle for it), and it is
  // persisted on the rule — an unvalidated one saves fine and only blows up
  // later, wherever the fix is applied. Validate pattern + flags together.
  const autofixError = useMemo(
    () => (showAutofix && afPattern ? validateRegex(afPattern, afFlags) : null),
    [showAutofix, afPattern, afFlags],
  )

  /** Switch mode, snapping `side` back to a value the new mode can express. */
  function selectMode(next: Mode) {
    setMode(next)
    if (!sidesForMode(next).includes(side)) setSide("target")
  }

  // ── Debounced draft check for live preview ──
  const [debouncedCheck, setDebouncedCheck] = useState<RuleCheck | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const currentCheck = useMemo(
    () => (patternError || sourcePatternError) ? null : buildCheck(side, mode, pattern, isLiteral, sourcePattern),
    [side, mode, pattern, isLiteral, sourcePattern, patternError, sourcePatternError],
  )

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedCheck(currentCheck), 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [currentCheck])

  const preview = usePreview(debouncedCheck, cells)

  // ── Autofix preview ──
  const afPreview = useMemo(() => {
    if (!afSample || !afPattern) return null
    try {
      const re = new RegExp(afPattern, afFlags)
      return afSample.replace(re, afReplacement)
    } catch {
      return null
    }
  }, [afSample, afPattern, afReplacement, afFlags])

  // ── Submit ──
  // Keep Create/Save clickable; surface why submit failed instead of disabling.
  const [attempted, setAttempted] = useState(false)
  const nameError = !name.trim() ? t("rules.editor.nameRequired") : null
  const checkError = !currentCheck
    ? mode === "required" && side === "target"
      ? t("rules.editor.sourceAndTargetPatternRequired")
      : t("rules.editor.patternRequired")
    : null
  const canSave = !nameError && !!currentCheck && !patternError && !sourcePatternError && !autofixError

  function handleSave() {
    setAttempted(true)
    if (!canSave) return
    const autofix: RuleAutofix | undefined = showAutofix && afPattern
      ? { kind: "regex-replace", pattern: afPattern, replacement: afReplacement, flags: afFlags }
      : undefined

    posthog.capture(initialRule ? "translation rule updated" : "translation rule created", {
      rule_name: name.trim(),
      severity,
      check_type: currentCheck!.type,
      has_autofix: !!autofix,
    })

    // Scope: the lane picker decides when shown; otherwise preserve the rule's
    // existing scope (an org-rule edit must not silently flip to `project`).
    const scoped: Pick<TranslationRule, "scope" | "lane"> = showLanePicker
      ? laneChoice === null
        // `lane: undefined` on purpose: an update spreads over the old rule, so
        // a lane→all-lanes change must overwrite the stale `lane` field.
        ? { scope: "project", lane: undefined }
        : { scope: "lane", lane: laneChoice }
      : { scope: initialRule?.scope ?? "project", lane: initialRule?.lane }

    onSave({
      name: name.trim(),
      description: description.trim(),
      severity,
      source: "user",
      ...scoped,
      check: currentCheck!,
      enabled,
      autofix,
    })
  }

  const sentence = humanSentence(side, mode, t)

  return (
    <div className={cn("overflow-hidden rounded-lg border bg-card p-4 space-y-4", className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">
          {initialRule ? t("rules.editor.editRuleHeading") : t("rules.editor.newRuleHeading")}
        </p>
        <Button variant="ghost" size="icon-sm" onClick={onCancel} aria-label={t("common.cancel")}>
          <X />
        </Button>
      </div>

      {/* Plain-language sentence */}
      <p className="text-sm text-muted-foreground italic">{sentence}</p>

      {/* Name + Description */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field data-invalid={attempted && !!nameError}>
          <FieldLabel htmlFor="re-name" className="text-xs">{t("rules.editor.nameLabel")}</FieldLabel>
          <Input
            id="re-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("rules.editor.namePlaceholder")}
            className="mt-1"
            aria-invalid={attempted && !!nameError}
          />
          {attempted && nameError && <FieldError>{nameError}</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor="re-desc" className="text-xs">
            {t("common.descriptionOptional")}
          </FieldLabel>
          <Input
            id="re-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("rules.editor.descriptionPlaceholder")}
            className="mt-1"
          />
        </Field>
      </div>

      {/* Mode selectors */}
      <div className="flex flex-wrap gap-3">
        <div>
          <FieldLabel className="text-xs">{t("common.modeLabel")}</FieldLabel>
          <div className="mt-1 flex gap-1">
            {(["forbidden", "required", "match"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => selectMode(m)}
                className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                  mode === m
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                {m === "forbidden"
                  ? t("rules.editor.mode.forbidden")
                  : m === "required"
                    ? t("rules.editor.mode.required")
                    : t("rules.editor.mode.match")}
              </button>
            ))}
          </div>
        </div>

        {/* Side only shows when not "match" (match implies both sides).
            A side the mode can't express stays visible but disabled with the
            reason spelled out (AQU-427 convention: explain, don't hide) — the
            alternative was a Save that failed with a pattern error. */}
        {mode !== "match" && (
          <div>
            <FieldLabel className="text-xs">{t("rules.editor.sideLabel")}</FieldLabel>
            <div className="mt-1 flex gap-1">
              {(["source", "target"] as Side[]).map((s) => {
                const supported = sidesForMode(mode).includes(s)
                return (
                  <button
                    key={s}
                    type="button"
                    disabled={!supported}
                    onClick={() => setSide(s)}
                    className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                      side === s
                        ? "bg-primary text-primary-foreground"
                        : supported
                          ? "bg-muted text-muted-foreground hover:bg-muted/80"
                          : "bg-muted/50 text-muted-foreground/50 cursor-not-allowed"
                    }`}
                  >
                    {s === "source" ? t("editor.column.source") : t("editor.column.target")}
                  </button>
                )
              })}
            </div>
            <p className="mt-1 max-w-56 text-[10px] text-muted-foreground">
              {t("rules.editor.sideTargetOnlyNote")}
            </p>
          </div>
        )}

        <div>
          <FieldLabel className="text-xs">{t("rules.editor.severityLabel")}</FieldLabel>
          <div className="mt-1 flex gap-1">
            {(["minor", "major"] as const).map((sv) => (
              <button
                key={sv}
                type="button"
                onClick={() => setSeverity(sv)}
                className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                  severity === sv
                    ? sv === "major"
                      ? "bg-red-500 text-white"
                      : "bg-amber-500 text-white"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                {sv === "major" ? t("rules.severity.major") : t("rules.severity.minor")}
              </button>
            ))}
          </div>
        </div>

        {/* AQU-609: lane scope — only for multi-lane project-rule editors.
            A searchable combobox, not a button row or plain dropdown:
            projects can carry 150+ lanes. Values are prefix-encoded
            ("scope:project" / "lane:<tag>") because the default lane's tag is
            the empty string. */}
        {showLanePicker && (
          <div>
            <FieldLabel className="text-xs">{t("rules.editor.laneLabel")}</FieldLabel>
            <LaneCombobox
              options={[
                { value: "scope:project", label: t("rules.editor.lane.allLanes") },
                { value: "lane:", label: laneLabels?.[""] || defaultLaneLabel || t("rules.editor.lane.defaultLane") },
                ...(lanes ?? []).map((l) => ({ value: `lane:${l}`, label: laneLabels?.[l] || l })),
              ]}
              value={laneChoice === null ? "scope:project" : `lane:${laneChoice}`}
              onValueChange={(v) =>
                setLaneChoice(v === "scope:project" ? null : v.slice("lane:".length))
              }
              searchPlaceholder={t("editor.lane.searchPlaceholder")}
              searchAriaLabel={t("editor.lane.searchAriaLabel")}
              emptyText={t("editor.lane.searchEmpty")}
              trigger={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-1"
                  aria-label={t("rules.editor.laneLabel")}
                >
                  {laneChoice === null
                    ? t("rules.editor.lane.allLanes")
                    : laneChoice === ""
                      ? laneLabels?.[""] || defaultLaneLabel || t("rules.editor.lane.defaultLane")
                      : laneLabels?.[laneChoice] || laneChoice}
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </Button>
              }
            />
          </div>
        )}

        <div className="flex items-end">
          <label className="flex items-center gap-1.5 text-xs">
            <Switch
              size="sm"
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(checked)}
            />
            <span className="text-muted-foreground">{t("rules.surface.enabledLabel")}</span>
          </label>
        </div>
      </div>

      {/* Source pattern (only for source-requires-target mode) */}
      {mode === "required" && (
        <div>
          <FieldLabel htmlFor="re-src-pat" className="text-xs">
            {t("rules.editor.sourcePatternLabel")}
          </FieldLabel>
          <div className="mt-1 flex gap-2 items-center">
            <Input
              id="re-src-pat"
              value={sourcePattern}
              onChange={(e) => setSourcePattern(e.target.value)}
              placeholder={isLiteral ? t("rules.editor.textToMatchPlaceholder") : "\\d+"}
              className={`font-mono text-xs flex-1 ${sourcePatternError ? "border-destructive" : ""}`}
            />
          </div>
          {sourcePatternError && (
            <p className="mt-1 text-xs text-destructive">{sourcePatternError}</p>
          )}
        </div>
      )}

      {/* Main pattern */}
      <div>
        <div className="flex items-center justify-between">
          <FieldLabel htmlFor="re-pat" className="text-xs">
            {mode === "required" ? t("rules.editor.targetPatternLabel") : t("rules.editor.patternLabel")}
          </FieldLabel>
          <button
            type="button"
            onClick={() => setIsLiteral((v) => !v)}
            className="text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {isLiteral ? t("rules.editor.switchToRegex") : t("rules.editor.switchToLiteral")}
          </button>
        </div>
        <Input
          id="re-pat"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder={isLiteral ? t("rules.editor.exactTextPlaceholder") : "\\d+"}
          className={`mt-1 font-mono text-xs ${patternError ? "border-destructive" : ""}`}
        />
        {patternError && (
          <p className="mt-1 text-xs text-destructive">{patternError}</p>
        )}
        {!patternError && pattern && (
          <p className="mt-1 text-[10px] text-muted-foreground">
            {isLiteral ? t("rules.editor.literalTextNote") : t("rules.editor.regexNote")}
          </p>
        )}
      </div>

      {/* Live preview */}
      {pattern && !patternError && !sourcePatternError && (
        <div className="rounded border bg-muted/30 p-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            {t("rules.editor.livePreviewHeading")}
          </p>
          {preview.count === 0 ? (
            <p className="text-xs text-muted-foreground">{t("rules.editor.noMatches")}</p>
          ) : (
            <>
              <p className="text-xs font-medium">
                {t("rules.editor.wouldBeFlagged", {
                  label: preview.count >= 3 ? "3+" : String(preview.count),
                  count: preview.count,
                })}
              </p>
              <ul className="space-y-1">
                {preview.samples.map((cell) => (
                  <li key={cell.id} className="rounded border bg-background p-2 text-xs">
                    <span className="text-muted-foreground">{t("rules.editor.srcLabel")} </span>
                    <span className="line-clamp-1">{cell.original}</span>
                    <span className="text-muted-foreground"> {t("rules.editor.tgtLabel")} </span>
                    <span className="line-clamp-1">{cell.translated}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {/* Autofix section */}
      <div>
        <button
          type="button"
          onClick={() => setShowAutofix((v) => !v)}
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {showAutofix ? t("rules.editor.hideAutofix") : t("rules.editor.addAutofix")}
        </button>
        {showAutofix && (
          <div className="mt-2 space-y-2 rounded border p-3">
            <p className="text-xs text-muted-foreground">
              {t("rules.editor.autofixRegexReplaceHeading")}
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div>
                <FieldLabel htmlFor="re-af-pattern" className="text-[10px]">
                  {t("rules.editor.findPatternLabel")}
                </FieldLabel>
                <Input
                  id="re-af-pattern"
                  value={afPattern}
                  onChange={(e) => setAfPattern(e.target.value)}
                  placeholder={t("rules.editor.patternLabel")}
                  className={`mt-1 font-mono text-xs ${autofixError ? "border-destructive" : ""}`}
                  aria-invalid={!!autofixError}
                />
              </div>
              <div>
                <FieldLabel htmlFor="re-af-replacement" className="text-[10px]">
                  {t("rules.editor.replaceWithLabel")}
                </FieldLabel>
                <Input
                  id="re-af-replacement"
                  value={afReplacement}
                  onChange={(e) => setAfReplacement(e.target.value)}
                  placeholder={t("rules.surface.autofixEditor.replacementPlaceholder")}
                  className="mt-1 font-mono text-xs"
                />
              </div>
              <div>
                <FieldLabel htmlFor="re-af-flags" className="text-[10px]">
                  {t("rules.editor.flagsLabel")}
                </FieldLabel>
                <Input
                  id="re-af-flags"
                  value={afFlags}
                  onChange={(e) => setAfFlags(e.target.value)}
                  placeholder="gi" // i18n-exempt regex flags syntax example, not natural-language text
                  className={`mt-1 font-mono text-xs ${autofixError ? "border-destructive" : ""}`}
                  aria-invalid={!!autofixError}
                />
              </div>
            </div>
            {/* Surfaced as soon as the pattern or flags are bad — not only once
                a sample is typed — because it now blocks Save. */}
            {autofixError && (
              <p className="text-xs text-destructive">
                {t("rules.editor.invalidAutofixPattern")}: {autofixError}
              </p>
            )}
            {/* Sample before/after */}
            <div>
              <FieldLabel htmlFor="re-af-sample" className="text-[10px]">
                {t("rules.editor.previewOnSampleLabel")}
              </FieldLabel>
              <Input
                id="re-af-sample"
                value={afSample}
                onChange={(e) => setAfSample(e.target.value)}
                placeholder={t("rules.editor.sampleTextPlaceholder")}
                className="mt-1 text-xs"
              />
              {afSample && afPreview !== null && (
                <div className="mt-1 flex gap-2 text-xs">
                  <span className="text-muted-foreground line-through">{afSample}</span>
                  <span>→</span>
                  <span className="text-green-700 dark:text-green-400">{afPreview}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Actions — match Terminology Add dialog DialogFooter */}
      {attempted && (checkError || patternError || sourcePatternError || autofixError) && (
        <FieldError>
          {checkError ?? patternError ?? sourcePatternError ?? autofixError}
        </FieldError>
      )}
      <div className="-mx-4 -mb-4 mt-1 flex flex-col-reverse gap-2 rounded-b-3xl bg-muted/40 p-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="button" onClick={handleSave}>
          {initialRule ? t("common.saveChanges") : t("rules.editor.createRuleButton")}
        </Button>
      </div>
    </div>
  )
}
