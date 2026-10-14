/**
 * AQU-1937: an extension's import contribution inside the platform's Import
 * dialog. The options form is rendered HERE, from the importer's declared
 * schema (manifest.importers[].options); dynamic choices (a catalog) are asked
 * of the extension headlessly. "Import" runs it headless with progress and
 * Cancel; re-running with the same options resumes (files.upsert is a delta,
 * so whatever already landed is a no-op).
 */

import { ExtensionFrame } from "./ExtensionFrame"
import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ToolImporter, ToolImporterOption } from "../../../shared/tools/manifest"
import { useToolsMount } from "./ToolsMountContext"

type Value = string | number | boolean | string[]

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
  const [choices, setChoices] = useState<Record<string, { value: string; label: string }[]>>({})
  const [loadingChoices, setLoadingChoices] = useState<Record<string, boolean>>({})
  const [run, setRun] = useState<{ key: string; message: string; fraction: number | null } | null>(null)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const askedFor = useRef(new Map<string, string>())

  // Dynamic choices: (re)asked when a field the choices depend on changes.
  const dynamicKeys = useMemo(
    () => importer.options.filter((o) => o.dynamic).map((o) => [o.key, JSON.stringify((o.dependsOn ?? []).map((d) => values[d]))] as const),
    [importer, values],
  )
  useEffect(() => {
    if (!ctx) return
    for (const [key, deps] of dynamicKeys) {
      if (askedFor.current.get(key) === deps) continue
      askedFor.current.set(key, deps)
      setLoadingChoices((prev) => ({ ...prev, [key]: true }))
      void ctx.importChoices(toolId, importer.id, key, values).then((outcome) => {
        setLoadingChoices((prev) => ({ ...prev, [key]: false }))
        if (outcome.ok) setChoices((prev) => ({ ...prev, [key]: outcome.choices ?? [] }))
      })
    }
  }, [ctx, dynamicKeys, toolId, importer.id, values])

  if (!ctx) return null
  const set = (key: string, v: Value) => setValues((prev) => ({ ...prev, [key]: v }))
  const missing = missingRequired(importer, values)

  const start = () => {
    setResult(null)
    const job = ctx.runImport(toolId, importer.id, values, {
      onProgress: (message, fraction) => setRun((prev) => (prev ? { ...prev, message, fraction } : prev)),
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
          <option value="">{loadingChoices[o.key] ? t("extensions.import.loading") : "—"}</option>
          {opts.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      )
    } else if (o.type === "multiselect") {
      const picked = Array.isArray(v) ? v : []
      control = loadingChoices[o.key] ? (
        <Spinner className="size-4" />
      ) : (
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
        {o.help && <p className="text-xs text-muted-foreground">{o.help}</p>}
      </div>
    )
  }

  return (
    <ExtensionFrame name={toolName} href={ctx.projectId ? `/project/${ctx.projectId}/extensions/${toolId}` : undefined}>
    <div className="flex flex-col gap-3 p-3" data-testid="extension-import-panel">
      {importer.description && <p className="text-sm text-muted-foreground">{importer.description}</p>}
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
