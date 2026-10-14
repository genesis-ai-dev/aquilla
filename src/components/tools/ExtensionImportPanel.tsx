/**
 * AQU-1937: an extension's import contribution inside the platform's Import
 * dialog. The options form is rendered HERE, from the importer's declared
 * schema (manifest.importers[].options); dynamic choices (a catalog) are asked
 * of the extension headlessly. "Import" runs it headless with progress and
 * Cancel; re-running with the same options resumes (files.upsert is a delta,
 * so whatever already landed is a no-op).
 */

import { ExtensionFrame } from "./ExtensionFrame"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ToolImporter, ToolImporterOption } from "../../../shared/tools/manifest"
import { useToolsMount } from "./ToolsMountContext"

type Value = string | number | boolean | string[]

/** The platform's own loading state for a dynamic field: spinner, what the
 *  extension says it is doing (or "Loading…"), elapsed seconds, and Cancel —
 *  drawn by the host, so every importer gets it. */
function ChoicesLoading({ since, message, onCancel, testId }: { since: number; message: string; onCancel: () => void; testId: string }) {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status" data-testid={testId}>
      <Spinner className="size-3" />
      <span className="min-w-0 truncate">{message}</span>
      <span className="tabular-nums" data-testid={`${testId}-elapsed`}>{t("extensions.import.choicesElapsed", { seconds })}</span>
      <Button size="sm" variant="ghost" className="ms-auto h-6 px-2 text-xs" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
    </div>
  )
}
type Choice = { value: string; label: string; group?: string }

/** Choices in first-seen group order (ungrouped first), for <optgroup>s. */
export function groupChoices(list: Choice[]): { group: string | null; items: Choice[] }[] {
  const out: { group: string | null; items: Choice[] }[] = []
  for (const c of list) {
    const g = c.group ?? null
    let bucket = out.find((b) => b.group === g)
    if (!bucket) {
      bucket = { group: g, items: [] }
      if (g === null) out.unshift(bucket)
      else out.push(bucket)
    }
    bucket.items.push(c)
  }
  return out
}

export function defaultImportOptions(importer: ToolImporter): Record<string, Value> {
  const out: Record<string, Value> = {}
  for (const o of importer.options) {
    if (o.default !== undefined) out[o.key] = o.default
    else if (o.type === "boolean") out[o.key] = false
    else if (o.type === "multiselect") out[o.key] = []
    else out[o.key] = ""
  }
  return out
}

function missingRequired(importer: ToolImporter, values: Record<string, Value>): string | null {
  for (const o of importer.options) {
    if (!o.required) continue
    const v = values[o.key]
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) return o.label
  }
  return null
}

export function ExtensionImportPanel({
  toolId,
  toolName,
  importer,
  onDone,
}: {
  toolId: string
  /** AQU-1937: shown on the host-drawn identity frame around the import. */
  toolName: string
  importer: ToolImporter
  onDone: () => void
}) {
  const t = useT()
  const ctx = useToolsMount()
  const [values, setValues] = useState<Record<string, Value>>(() => defaultImportOptions(importer))
  const [choices, setChoices] = useState<Record<string, { value: string; label: string; group?: string }[]>>({})
  const [loadingChoices, setLoadingChoices] = useState<Record<string, boolean>>({})
  const [choicesError, setChoicesError] = useState<Record<string, string | null>>({})
  const [choicesProgress, setChoicesProgress] = useState<Record<string, string | null>>({})
  const [choicesSince, setChoicesSince] = useState<Record<string, number>>({})
  const choiceJobs = useRef(new Map<string, string>())
  // A permission the extension is waiting on, drawn here (inside the dialog).
  const [prompt, setPrompt] = useState<ReactNode | null>(null)
  const [run, setRun] = useState<{ key: string; message: string; fraction: number | null } | null>(null)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const askedFor = useRef(new Map<string, string>())

  // Dynamic choices: (re)asked when a field the choices depend on changes.
  const dynamicKeys = useMemo(
    () => importer.options.filter((o) => o.dynamic).map((o) => [o.key, JSON.stringify((o.dependsOn ?? []).map((d) => values[d]))] as const),
    [importer, values],
  )
  const ask = useCallback(
    (key: string, deps: string, fresh: boolean) => {
      if (!ctx) return
      askedFor.current.set(key, deps)
      setLoadingChoices((prev) => ({ ...prev, [key]: true }))
      setChoicesError((prev) => ({ ...prev, [key]: null }))
      setChoicesProgress((prev) => ({ ...prev, [key]: null }))
      setChoicesSince((prev) => ({ ...prev, [key]: Date.now() }))
      void ctx
        .importChoices(toolId, importer.id, key, values, {
          fresh,
          onStart: (jobKey) => choiceJobs.current.set(key, jobKey),
          onProgress: (message) => {
            if (askedFor.current.get(key) === deps) setChoicesProgress((prev) => ({ ...prev, [key]: message }))
          },
          onPrompt: setPrompt,
        })
        .then((outcome) => {
          // A newer ask for this field (its dependencies changed) owns the field now.
          if (askedFor.current.get(key) !== deps) return
          setLoadingChoices((prev) => ({ ...prev, [key]: false }))
          setChoicesProgress((prev) => ({ ...prev, [key]: null }))
          if (outcome.ok) setChoices((prev) => ({ ...prev, [key]: outcome.choices ?? [] }))
          // Never a silent "—": say why the list is empty (with Retry).
          setChoicesError((prev) => ({ ...prev, [key]: outcome.ok ? null : outcome.error }))
        })
    },
    [ctx, toolId, importer.id, values],
  )
  useEffect(() => {
    for (const [key, deps] of dynamicKeys) {
      if (askedFor.current.get(key) !== deps) ask(key, deps, false)
    }
  }, [dynamicKeys, ask])

  if (!ctx) return null
  const set = (key: string, v: Value) => setValues((prev) => ({ ...prev, [key]: v }))
  const missing = missingRequired(importer, values)

  const start = () => {
    setResult(null)
    const job = ctx.runImport(toolId, importer.id, values, {
      onProgress: (message, fraction) => setRun((prev) => (prev ? { ...prev, message, fraction } : prev)),
      onPrompt: setPrompt,
    })
    setRun({ key: job.key, message: "", fraction: null })
    void job.done.then((outcome) => {
      setRun(null)
      setResult(outcome.ok ? { ok: true, message: outcome.message ?? t("extensions.import.done") } : { ok: false, message: outcome.error })
    })
  }

  const field = (o: ToolImporterOption) => {
    const id = `ext-import-${o.key}`
    const opts = o.dynamic ? (choices[o.key] ?? []) : (o.choices ?? [])
    const v = values[o.key]
    let control
    if (o.type === "boolean") {
      control = <Checkbox id={id} checked={v === true} onCheckedChange={(c) => set(o.key, c === true)} />
    } else if (o.type === "select") {
      control = (
        <select id={id} className="h-8 w-full rounded-md border bg-background px-2 text-sm" value={String(v ?? "")} onChange={(e) => set(o.key, e.target.value)}>
          <option value="">{loadingChoices[o.key] ? (choicesProgress[o.key] ?? t("extensions.import.loading")) : "—"}</option>
          {groupChoices(opts).map(({ group, items }) => {
            const rows = items.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))
            return group ? <optgroup key={group} label={group}>{rows}</optgroup> : rows
          })}
        </select>
      )
    } else if (o.type === "multiselect") {
      const picked = Array.isArray(v) ? v : []
      // Loading: the platform's loading row below the field says what is happening.
      control = loadingChoices[o.key] ? null : (
        <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-md border p-2" role="group" aria-labelledby={`${id}-label`}>
          {opts.map((c) => (
            <label key={c.value} className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs">
              <Checkbox
                checked={picked.includes(c.value)}
                onCheckedChange={(on) => set(o.key, on === true ? [...picked, c.value] : picked.filter((x) => x !== c.value))}
                aria-label={c.label}
              />
              {c.label}
            </label>
          ))}
        </div>
      )
    } else {
      control = (
        <Input
          id={id}
          type={o.type === "number" ? "number" : "text"}
          value={String(v ?? "")}
          onChange={(e) => set(o.key, o.type === "number" ? Number(e.target.value) : e.target.value)}
        />
      )
    }
    return (
      <div key={o.key} className="flex flex-col gap-1" data-testid={`extension-import-option-${o.key}`}>
        <label id={`${id}-label`} htmlFor={id} className="text-xs font-medium">
          {o.label}
          {o.required ? " *" : ""}
        </label>
        {control}
        {loadingChoices[o.key] && (
          <ChoicesLoading
            since={choicesSince[o.key] ?? Date.now()}
            message={prompt ? t("extensions.import.waitingPermission") : (choicesProgress[o.key] ?? t("extensions.import.loading"))}
            testId={`extension-import-choices-loading-${o.key}`}
            onCancel={() => {
              const jobKey = choiceJobs.current.get(o.key)
              if (jobKey) ctx.cancelJob(jobKey)
            }}
          />
        )}
        {choicesError[o.key] && (
          <div className="flex items-center gap-2" role="alert">
            <p className="text-xs text-destructive" data-testid={`extension-import-choices-error-${o.key}`}>
              {choicesError[o.key] === "cancelled"
                ? t("extensions.import.choicesCancelled")
                : t("extensions.import.choicesFailed", { error: choicesError[o.key] ?? "" })}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              data-testid={`extension-import-choices-retry-${o.key}`}
              onClick={() => ask(o.key, askedFor.current.get(o.key) ?? "", true)}
            >
              {t("extensions.import.choicesRetry")}
            </Button>
          </div>
        )}
        {o.help && <p className="text-xs text-muted-foreground">{o.help}</p>}
      </div>
    )
  }

  return (
    <ExtensionFrame name={toolName} href={ctx.projectId ? `/project/${ctx.projectId}/extensions/${toolId}` : undefined}>
    <div className="flex flex-col gap-3 p-3" data-testid="extension-import-panel">
      {importer.description && <p className="text-sm text-muted-foreground">{importer.description}</p>}
      {prompt && (
        <div className="rounded-md border" data-testid="extension-import-permission">
          {prompt}
        </div>
      )}
      {importer.options.map(field)}
      {run && (
        <div className="flex flex-col gap-1" role="status" data-testid="extension-import-progress">
          <Progress value={run.fraction == null ? null : Math.round(run.fraction * 100)} />
          <p className="text-xs text-muted-foreground">{run.message || t("extensions.import.running")}</p>
        </div>
      )}
      {result && (
        <p role={result.ok ? "status" : "alert"} className={result.ok ? "text-sm" : "text-sm text-destructive"} data-testid="extension-import-result">
          {result.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {run ? (
          <Button variant="outline" onClick={() => ctx.cancelJob(run.key)} data-testid="extension-import-cancel">
            {t("common.cancel")}
          </Button>
        ) : result?.ok ? (
          <Button onClick={onDone} data-testid="extension-import-close">{t("common.close")}</Button>
        ) : (
          <Button disabled={missing !== null} onClick={start} data-testid="extension-import-run" title={missing ? t("extensions.import.missing", { field: missing }) : undefined}>
            {result ? t("extensions.import.retry") : t("extensions.import.run")}
          </Button>
        )}
      </div>
    </div>
    </ExtensionFrame>
  )
}
