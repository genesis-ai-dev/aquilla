// AQU-1075: the downstream maintainer chooses which settings a link copies.
// The same list is the confirm step of a new link and the card in the
// downstream project's settings. A field that is still arriving says which
// project it came from and offers Detach.

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { SettingsGroup } from "@/components/ui/page"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { fetchProject } from "@/lib/sync/projects-read"
import {
  INHERIT_FIELD_IDS,
  isReceiving,
  parseInheritedFromLink,
  type InheritFieldId,
  type InheritedFromLink,
} from "@/lib/sync/inherited-settings"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

const FIELD_LABEL: Record<InheritFieldId, MessageKey> = {
  translationBrief: "projectSettings.inherit.field.translationBrief",
  knowledgeDocs: "projectSettings.inherit.field.knowledgeDocs",
  workflowPolicy: "projectSettings.inherit.field.workflowPolicy",
  livingMemory: "projectSettings.inherit.field.livingMemory",
  smartQuotes: "projectSettings.inherit.field.smartQuotes",
  systemPrompt: "projectSettings.inherit.field.systemPrompt",
}

export function useUpstreamProjectName(sourceProjectId: string | null | undefined): string | null {
  const { session } = useFrontierSession()
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    if (!sourceProjectId || !session?.jwt) return
    let cancelled = false
    fetchProject(sourceProjectId, session.jwt)
      .then((project) => {
        if (!cancelled) setName(project.name)
      })
      .catch(() => {
        if (!cancelled) setName(sourceProjectId)
      })
    return () => {
      cancelled = true
    }
  }, [sourceProjectId, session?.jwt])
  return name
}

export function InheritedFieldNote({
  field,
  upstreamName,
  config,
  canEdit,
  onDetach,
}: {
  field: InheritFieldId
  upstreamName: string | null
  config: InheritedFromLink | null
  canEdit: boolean
  onDetach: (field: InheritFieldId) => void
}) {
  const t = useT()
  if (!config || !upstreamName || !isReceiving(config, field)) return null
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{t("projectSettings.inherit.fromUpstream", { upstream: upstreamName })}</span>
      {canEdit && (
        <Button type="button" variant="outline" size="sm" onClick={() => onDetach(field)}>
          {t("projectSettings.inherit.detach")}
        </Button>
      )}
    </p>
  )
}

export function InheritedSettingsChoice({
  title,
  description,
  receive,
  detached,
  upstreamName,
  disabled,
  showFrom,
  onChange,
}: {
  title: string
  description: string
  receive: Record<InheritFieldId, boolean>
  detached: Partial<Record<InheritFieldId, boolean>>
  upstreamName?: string | null
  disabled?: boolean
  /** Settings card: a receiving field names its upstream and can be detached. */
  showFrom?: boolean
  onChange: (next: Pick<InheritedFromLink, "receive" | "detached">) => void
}) {
  const t = useT()
  const config: InheritedFromLink = { receive, detached }

  function setField(field: InheritFieldId, on: boolean) {
    const nextDetached = { ...detached }
    if (on) delete nextDetached[field]
    else nextDetached[field] = true
    onChange({
      receive: { ...receive, [field]: on },
      detached: nextDetached,
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        {title ? <p className="text-sm font-medium">{title}</p> : null}
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <ul className="flex flex-col gap-2">
        {INHERIT_FIELD_IDS.map((field) => {
          const on = isReceiving(config, field)
          const label = t(FIELD_LABEL[field])
          return (
            <li key={field} className="flex flex-col gap-1">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={on}
                  disabled={disabled}
                  onCheckedChange={(value) => setField(field, value === true)}
                />
                <span>
                  {label}
                  {field === "workflowPolicy" && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {t("projectSettings.inherit.field.workflowPolicyDetail")}
                    </span>
                  )}
                </span>
              </label>
              {showFrom && on && upstreamName && (
                <div className="ps-6">
                  <InheritedFieldNote
                    field={field}
                    upstreamName={upstreamName}
                    config={config}
                    canEdit={!disabled}
                    onDetach={(id) => setField(id, false)}
                  />
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** The card in the downstream project's settings. */
export function InheritedSettingsSection({
  sourceProjectId,
  settings,
  canEdit,
  onPatch,
}: {
  sourceProjectId: string
  settings: ProjectWideSettings | null | undefined
  canEdit: boolean
  onPatch: (partial: ProjectWideSettings) => Promise<unknown>
}) {
  const t = useT()
  const upstreamName = useUpstreamProjectName(sourceProjectId)
  const stored = parseInheritedFromLink(settings?.inheritedFromLink)
  const receive = stored?.receive ?? {
    translationBrief: false,
    knowledgeDocs: false,
    workflowPolicy: false,
    livingMemory: false,
    smartQuotes: false,
    systemPrompt: false,
  }
  const detached = stored?.detached ?? {}
  const name = upstreamName ?? sourceProjectId

  return (
    <SettingsGroup label={t("projectSettings.inherit.title", { upstream: name })}>
      <div className="px-4 py-3">
        <InheritedSettingsChoice
          title=""
          description={t("projectSettings.inherit.description", { upstream: name })}
          receive={receive}
          detached={detached}
          upstreamName={name}
          disabled={!canEdit}
          showFrom
          onChange={(next) => {
            void onPatch({ inheritedFromLink: { ...stored, ...next } })
          }}
        />
      </div>
    </SettingsGroup>
  )
}
