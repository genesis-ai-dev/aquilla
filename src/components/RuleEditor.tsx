/**
 * RuleEditor — plain-language inline rule editor (AQU-195).
 *
 * Used for BOTH create and edit. Renders inline inside RulesSurface (no dialog).
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
import { X } from "lucide-react"
import type { TranslationRule, RuleCheck, RuleAutofix } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
import posthog from "@/lib/posthog"

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Escape a literal string so it is safe inside a RegExp. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Validate a regex string. Returns null if valid, error message if invalid. */
export function validateRegex(pattern: string): string | null {
  if (!pattern) return null
  try {
    new RegExp(pattern)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : "Invalid regex"
  }
}

type Side = "source" | "target"
type Mode = "required" | "forbidden" | "match"

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

function humanSentence(side: Side, mode: Mode): string {
  if (mode === "forbidden") return `On the ${side}, this pattern is forbidden.`
  if (mode === "required") return `When the source matches a pattern, the target must contain this pattern.`
  if (mode === "match") return `This pattern must appear in both source and target.`
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
}

export function RuleEditor({ initialRule, cells, onSave, onCancel }: RuleEditorProps) {
  // ── Field state ──
  const [name, setName] = useState(initialRule?.name ?? "")
  const [description, setDescription] = useState(initialRule?.description ?? "")
  const [severity, setSeverity] = useState<"major" | "minor">(initialRule?.severity ?? "minor")
  const [enabled, setEnabled] = useState(initialRule?.enabled ?? true)

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
  const nameError = !name.trim() ? "Rule name is required" : null
  const checkError = !currentCheck
    ? mode === "required" && side === "target"
      ? "Source pattern and target pattern are required"
      : "Pattern is required"
    : null
  const canSave = !nameError && !!currentCheck && !patternError && !sourcePatternError

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

    onSave({
      name: name.trim(),
      description: description.trim(),
      severity,
      source: "user",
      scope: "project",
      check: currentCheck!,
      enabled,
      autofix,
    })
  }

  const sentence = humanSentence(side, mode)

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">
          {initialRule ? "Edit rule" : "New rule"}
        </p>
        <Button variant="ghost" size="sm" onClick={onCancel} aria-label="Cancel">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Plain-language sentence */}
      <p className="text-sm text-muted-foreground italic">{sentence}</p>

      {/* Name + Description */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field data-invalid={attempted && !!nameError}>
          <FieldLabel htmlFor="re-name" className="text-xs">Rule name</FieldLabel>
          <Input
            id="re-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Preserve numbers"
            className="mt-1"
            aria-invalid={attempted && !!nameError}
          />
          {attempted && nameError && <FieldError>{nameError}</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor="re-desc" className="text-xs">Description (optional)</FieldLabel>
          <Input
            id="re-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Numbers in source must appear in target"
            className="mt-1"
          />
        </Field>
      </div>

      {/* Mode selectors */}
      <div className="flex flex-wrap gap-3">
        <div>
          <FieldLabel className="text-xs">Mode</FieldLabel>
          <div className="mt-1 flex gap-1">
            {(["forbidden", "required", "match"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                  mode === m
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                {m === "forbidden" ? "Forbidden" : m === "required" ? "Required" : "Must match"}
              </button>
            ))}
          </div>
        </div>

        {/* Side only shows when not "match" (match implies both sides) */}
        {mode !== "match" && (
          <div>
            <FieldLabel className="text-xs">Side</FieldLabel>
            <div className="mt-1 flex gap-1">
              {(["source", "target"] as Side[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSide(s)}
                  className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                    side === s
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/80"
                  }`}
                >
                  {s === "source" ? "Source" : "Target"}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <FieldLabel className="text-xs">Severity</FieldLabel>
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
                {sv === "major" ? "Major" : "Minor"}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-end">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <Switch
              size="sm"
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(checked)}
            />
            <span className="text-muted-foreground">Enabled</span>
          </label>
        </div>
      </div>

      {/* Source pattern (only for source-requires-target mode) */}
      {mode === "required" && (
        <div>
          <FieldLabel htmlFor="re-src-pat" className="text-xs">
            Source pattern — when source contains this…
          </FieldLabel>
          <div className="mt-1 flex gap-2 items-center">
            <Input
              id="re-src-pat"
              value={sourcePattern}
              onChange={(e) => setSourcePattern(e.target.value)}
              placeholder={isLiteral ? "text to match" : "\\d+"}
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
            {mode === "required" ? "…target must contain this pattern" : "Pattern"}
          </FieldLabel>
          <button
            type="button"
            onClick={() => setIsLiteral((v) => !v)}
            className="text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {isLiteral ? "Switch to regex" : "Switch to literal text"}
          </button>
        </div>
        <Input
          id="re-pat"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder={isLiteral ? "exact text to match" : "\\d+"}
          className={`mt-1 font-mono text-xs ${patternError ? "border-destructive" : ""}`}
        />
        {patternError && (
          <p className="mt-1 text-xs text-destructive">{patternError}</p>
        )}
        {!patternError && pattern && (
          <p className="mt-1 text-[10px] text-muted-foreground">
            {isLiteral ? "Treated as literal text (auto-escaped)" : "Interpreted as regular expression"}
          </p>
        )}
      </div>

      {/* Live preview */}
      {pattern && !patternError && !sourcePatternError && (
        <div className="rounded border bg-muted/30 p-3 space-y-2">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
            Live preview — current file
          </p>
          {preview.count === 0 ? (
            <p className="text-xs text-muted-foreground">No matches in the current file.</p>
          ) : (
            <>
              <p className="text-xs font-medium">
                {preview.count >= 3 ? "3+" : preview.count} cell{preview.count !== 1 ? "s" : ""} would be flagged
              </p>
              <ul className="space-y-1">
                {preview.samples.map((cell) => (
                  <li key={cell.id} className="rounded border bg-background p-2 text-xs">
                    <span className="text-muted-foreground">src: </span>
                    <span className="line-clamp-1">{cell.original}</span>
                    <span className="text-muted-foreground"> tgt: </span>
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
          {showAutofix ? "Hide autofix" : "Add autofix (optional)"}
        </button>
        {showAutofix && (
          <div className="mt-2 space-y-2 rounded border p-3">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              Autofix — regex replace
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div>
                <FieldLabel className="text-[10px]">Find pattern</FieldLabel>
                <Input
                  value={afPattern}
                  onChange={(e) => setAfPattern(e.target.value)}
                  placeholder="pattern"
                  className="mt-1 font-mono text-xs"
                />
              </div>
              <div>
                <FieldLabel className="text-[10px]">Replace with</FieldLabel>
                <Input
                  value={afReplacement}
                  onChange={(e) => setAfReplacement(e.target.value)}
                  placeholder="replacement"
                  className="mt-1 font-mono text-xs"
                />
              </div>
              <div>
                <FieldLabel className="text-[10px]">Flags</FieldLabel>
                <Input
                  value={afFlags}
                  onChange={(e) => setAfFlags(e.target.value)}
                  placeholder="gi"
                  className="mt-1 font-mono text-xs"
                />
              </div>
            </div>
            {/* Sample before/after */}
            <div>
              <FieldLabel className="text-[10px]">Preview on sample text</FieldLabel>
              <Input
                value={afSample}
                onChange={(e) => setAfSample(e.target.value)}
                placeholder="Type sample text to see before/after…"
                className="mt-1 text-xs"
              />
              {afSample && afPreview !== null && (
                <div className="mt-1 flex gap-2 text-xs">
                  <span className="text-muted-foreground line-through">{afSample}</span>
                  <span>→</span>
                  <span className="text-green-700 dark:text-green-400">{afPreview}</span>
                </div>
              )}
              {afSample && afPreview === null && afPattern && (
                <p className="mt-1 text-xs text-destructive">Invalid autofix pattern</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2 pt-1">
        {attempted && (checkError || patternError || sourcePatternError) && (
          <FieldError>
            {checkError ?? patternError ?? sourcePatternError}
          </FieldError>
        )}
        <div className="flex gap-2">
          <Button size="sm" onClick={handleSave}>
            {initialRule ? "Save changes" : "Create rule"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}
