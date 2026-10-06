// "Project decisions" card (AQU-1691), under the Language profile card in
// Settings → General → Languages.
//
// The decision log: the answers a team gave to Autopilot's questions, which
// every later draft follows (db/shared/project-facts.ts). Each row shows the
// key, the value, where it applies, who decided it and when. Maintainers can
// edit a decision's value, scope and note, or remove it; an edit is a new
// decision, so it takes the editor's name and today's date.
//
// Like the Language profile card, it saves through the page's shared-settings
// `patch`. It writes `projectFacts` over the STORED list (upsertProjectFact /
// removeProjectFact), so an entry this version cannot read is never deleted.

import { useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { SettingsBlock, SettingsGroup } from "@/components/ui/page"
import type { PatchOutcome } from "@/hooks/useProjectSettings"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { useFormat } from "@/lib/i18n/format"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"
import {
  projectFactProblem,
  readProjectFacts,
  removeProjectFact,
  upsertProjectFact,
  type FactScope,
  type ProjectFact,
} from "../../../db/shared/project-facts"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"

export interface ProjectDecisionsSectionProps {
  /** The stored `projectFacts`, as it is. */
  value: unknown[] | undefined
  /** Mirrors the server's maintainer floor for the settings PATCH. */
  canEdit: boolean
  disabledTooltip: ReactNode
  /** Who is editing: an edited decision is theirs. */
  username: string
  patch: (partial: ProjectWideSettings) => Promise<PatchOutcome>
}

type Status = { kind: "done"; key: MessageKey } | { kind: "error"; message: string } | null

function saveError(outcome: PatchOutcome, t: TFunction): string | null {
  if (outcome.kind === "ok") return null
  if (outcome.kind === "conflict") return t("projectDecisions.error.conflict")
  if (outcome.kind === "blocked") {
    return outcome.reason === "offline" ? t("projectDecisions.error.offline") : t("projectDecisions.error.permission")
  }
  return t("projectDecisions.error.failed")
}

function ScopeLine({ scope }: { scope: FactScope }) {
  const t = useT()
  const where = scope.passage
    ? t("projectDecisions.scope.passage", { from: scope.passage.from, to: scope.passage.to })
    : (scope.book ?? (scope.entity ? null : t("projectDecisions.scope.project")))
  return (
    <>
      {where ? <span>{where}</span> : null}
      {scope.entity ? <span>{t("projectDecisions.scope.about", { entity: scope.entity })}</span> : null}
    </>
  )
}

interface EditorProps {
  fact: ProjectFact
  username: string
  busy: boolean
  onSave: (next: ProjectFact) => void
  onInvalid: () => void
  onCancel: () => void
}

function DecisionEditor({ fact, username, busy, onSave, onInvalid, onCancel }: EditorProps) {
  const t = useT()
  const [draft, setDraft] = useState({
    value: fact.value,
    book: fact.scope.book ?? "",
    from: fact.scope.passage?.from ?? "",
    to: fact.scope.passage?.to ?? "",
    entity: fact.scope.entity ?? "",
    note: fact.note ?? "",
  })
  const field = (name: keyof typeof draft, label: MessageKey, multiline = false) => {
    const id = `project-decision-${fact.id}-${name}`
    const onChange = (value: string) => setDraft({ ...draft, [name]: value })
    return (
      <div className="space-y-1">
        <label htmlFor={id} className="text-sm">{t(label)}</label>
        {multiline ? (
          <Textarea id={id} rows={2} value={draft[name]} disabled={busy} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <Input id={id} value={draft[name]} disabled={busy} onChange={(e) => onChange(e.target.value)} />
        )}
      </div>
    )
  }

  function save() {
    const scope: FactScope = {}
    if (draft.book.trim()) scope.book = draft.book.trim()
    if (draft.from.trim() || draft.to.trim()) {
      scope.passage = { from: draft.from.trim(), to: (draft.to.trim() || draft.from).trim() }
    }
    if (draft.entity.trim()) scope.entity = draft.entity.trim()
    const next: ProjectFact = {
      id: fact.id,
      key: fact.key,
      value: draft.value.trim(),
      scope,
      ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
      author: username,
      at: new Date().toISOString(),
      ...(fact.sourceDecisionId ? { sourceDecisionId: fact.sourceDecisionId } : {}),
    }
    if (projectFactProblem(next) !== null) onInvalid()
    else onSave(next)
  }

  return (
    <div className="space-y-3 px-4 py-3" data-testid="project-decision-editor">
      <p className="break-all font-mono text-xs text-muted-foreground">{fact.key}</p>
      {field("value", "projectDecisions.field.value", true)}
      <div className="grid gap-3 sm:grid-cols-3">
        {field("book", "projectDecisions.field.book")}
        {field("from", "projectDecisions.field.from")}
        {field("to", "projectDecisions.field.to")}
      </div>
      <p className="text-xs text-muted-foreground">{t("projectDecisions.field.scopeHint")}</p>
      {field("entity", "projectDecisions.field.entity")}
      {field("note", "projectDecisions.field.note", true)}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={save}>{t("common.save")}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{t("common.cancel")}</Button>
      </div>
    </div>
  )
}

export function ProjectDecisionsSection({ value, canEdit, disabledTooltip, username, patch }: ProjectDecisionsSectionProps) {
  const t = useT()
  const format = useFormat()
  const [editing, setEditing] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const [saving, setSaving] = useState(false)
  // Newest first: the decision someone just made is the one they look for.
  const facts = readProjectFacts(value).sort((a, b) => b.at.localeCompare(a.at))
  const busy = !canEdit || saving

  async function write(next: unknown[], done: MessageKey) {
    setSaving(true)
    try {
      const error = saveError(await patch({ projectFacts: next }), t)
      setStatus(error ? { kind: "error", message: error } : { kind: "done", key: done })
      if (!error) {
        setEditing(null)
        setRemoving(null)
      }
    } finally {
      setSaving(false)
    }
  }

  function saveEdit(next: ProjectFact) {
    const upserted = upsertProjectFact(value, next)
    if (!upserted.ok) setStatus({ kind: "error", message: t("projectDecisions.invalid") })
    else void write(upserted.facts, "projectDecisions.saved")
  }

  return (
    <SettingsGroup label={t("projectDecisions.title")} description={t("projectDecisions.description")}>
      {facts.length === 0 ? (
        <SettingsBlock>
          <p className="text-sm text-muted-foreground">{t("projectDecisions.empty")}</p>
        </SettingsBlock>
      ) : null}
      {facts.map((fact) =>
        editing === fact.id ? (
          <DecisionEditor
            key={fact.id}
            fact={fact}
            username={username}
            busy={busy}
            onSave={saveEdit}
            onInvalid={() => setStatus({ kind: "error", message: t("projectDecisions.invalid") })}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div key={fact.id} className="space-y-2 px-4 py-3" data-testid="project-decision">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-0.5">
                <p className="break-all font-mono text-xs text-muted-foreground">{fact.key}</p>
                <p className="break-words text-sm">{fact.value}</p>
                <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <ScopeLine scope={fact.scope} />
                  <span>{t("projectDecisions.byline", { author: fact.author, date: format.date(fact.at) })}</span>
                </p>
                {fact.note ? <p className="break-words text-xs text-muted-foreground">{fact.note}</p> : null}
              </div>
              <DisabledFieldTooltip disabled={!canEdit} tooltip={disabledTooltip}>
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={t("projectDecisions.editAriaLabel", { key: fact.key })}
                    onClick={() => {
                      setStatus(null)
                      setEditing(fact.id)
                    }}
                  >
                    {t("common.edit")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={t("projectDecisions.removeAriaLabel", { key: fact.key })}
                    onClick={() => {
                      setStatus(null)
                      setRemoving(fact.id)
                    }}
                  >
                    {t("projectDecisions.remove")}
                  </Button>
                </div>
              </DisabledFieldTooltip>
            </div>
            {removing === fact.id ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>{t("projectDecisions.removeConfirm")}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void write(removeProjectFact(value, fact.id), "projectDecisions.removed")}
                >
                  {t("projectDecisions.remove")}
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>
                  {t("common.cancel")}
                </Button>
              </div>
            ) : null}
          </div>
        ),
      )}
      {status ? (
        <SettingsBlock>
          <p
            role={status.kind === "error" ? "alert" : "status"}
            className={status.kind === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
          >
            {status.kind === "error" ? status.message : t(status.key)}
          </p>
        </SettingsBlock>
      ) : null}
    </SettingsGroup>
  )
}
