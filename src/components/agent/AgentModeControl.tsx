/**
 * AgentModeControl.tsx — the agent team's autonomy dial (v3 of the 2026-08-28
 * social-workspace design), a compact button in the Team surface's roster row
 * that opens the whole model in one popover.
 *
 * The design premise from the session: autonomy is a dial expressed as a
 * process graph with parts switched on or off, not a single Auto checkbox.
 * So the popover shows all three of them at once — the named presets, the two
 * loops those presets are shorthand for, and the scope bound — with the
 * process graph beneath as the view-first answer to "what actually runs".
 * (Graph EDITING is deliberately out: per the meeting, "we don't have to make
 * a whole way to customize it yet".)
 *
 * Saving is immediate and optimistic. A dial that needed a Save button would
 * invite the state where the UI says Autopilot and the server says Manual,
 * which for an autonomy control is the one lie that matters — so a flip lands
 * on screen at once and REVERTS visibly, with the reason inline, if the write
 * is refused. Sub-project-lead viewers get that refusal as an explanation
 * rather than a hidden control, because "why can't I change this" is a
 * question worth answering.
 *
 * Monochrome discipline: identity comes from the icons, the single accent is
 * reserved for the checked switches and the selected preset.
 */

import { useCallback, useEffect, useState } from "react"
import { SlidersHorizontal, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { ROLE } from "@/lib/frontier/roles"
import {
  AGENT_MODE_PRESETS,
  AGENT_MODE_SCOPES,
  agentModeDescriptionKey,
  agentModeNameKey,
  fetchAgentMode,
  patchAgentMode,
  presetFor,
  type AgentMode,
  type AgentModeScope,
} from "@/lib/agent/agent-mode"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { requestReactCheck } from "@/lib/contextual/transport"
import { AutopilotProcessGraph } from "@/components/contextual/AutopilotProcessGraph"

const SCOPE_LABEL_KEYS = {
  full: "agent.mode.scope.full",
  qa: "agent.mode.scope.qa",
  draft: "agent.mode.scope.draft",
} as const satisfies Record<AgentModeScope, MessageKey>

export interface AgentModeControlProps {
  projectId: string
  /** Session JWT. Without one the dial reads but never writes. */
  jwt?: string | null
  /** Project role level — the settings route refuses writes below lead. */
  roleLevel?: number | null
}

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "started"; count: number }
  | { kind: "nothing" }
  | { kind: "unavailable" }
  | { kind: "failed" }

export function AgentModeControl({ projectId, jwt, roleLevel }: AgentModeControlProps) {
  const { t } = useI18n()
  const [mode, setMode] = useState<AgentMode | null>(null)
  const [version, setVersion] = useState<number | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [check, setCheck] = useState<CheckState>({ kind: "idle" })

  const canEdit = Boolean(jwt) && (roleLevel ?? 0) >= ROLE.PROJECT_LEAD
  const canCheck = (roleLevel ?? 0) >= ROLE.CONTRIBUTOR

  useEffect(() => {
    if (!jwt) return
    let disposed = false
    void fetchAgentMode(jwt, projectId).then((state) => {
      if (disposed) return
      if (!state) {
        // Unknown, NOT "all off" — never render an autonomy claim we can't back.
        setLoadFailed(true)
        return
      }
      setMode(state.mode)
      setVersion(state.version)
      setLoadFailed(false)
    })
    return () => {
      disposed = true
    }
  }, [jwt, projectId])

  const save = useCallback(
    (next: AgentMode) => {
      if (!jwt || !mode || version === null) return
      const previous = mode
      const previousVersion = version
      setMode(next)
      setSaveError(null)
      void patchAgentMode(jwt, projectId, next, version).then((outcome) => {
        if (outcome.kind === "ok") {
          setMode(outcome.state.mode)
          setVersion(outcome.state.version)
          return
        }
        // Optimism is only honest if it un-does itself out loud.
        setMode(previous)
        setVersion(previousVersion)
        setSaveError(
          outcome.kind === "forbidden" ? t("agent.mode.forbidden") : t("agent.mode.saveFailed"),
        )
      })
    },
    [jwt, mode, projectId, t, version],
  )

  const runCheck = useCallback(() => {
    setCheck({ kind: "checking" })
    void requestReactCheck(projectId)
      .then((result) => {
        if (!result) {
          setCheck({ kind: "unavailable" })
          return
        }
        setCheck(
          result.reactions.length > 0
            ? { kind: "started", count: result.reactions.length }
            : { kind: "nothing" },
        )
      })
      .catch(() => setCheck({ kind: "failed" }))
  }, [projectId])

  const label = mode ? t(agentModeNameKey(mode)) : t("agent.mode.title")
  const selectedPreset = mode ? presetFor(mode) : "custom"

  // The check's outcome resolved to one line up front — every click gets an
  // answer, including "nothing to do", so the button never looks inert.
  const checkNote: { text: string; alert: boolean } | null =
    check.kind === "unavailable"
      ? { text: t("agent.mode.checkUnavailable"), alert: false }
      : check.kind === "failed"
        ? { text: t("agent.mode.checkFailed"), alert: true }
        : check.kind === "nothing"
          ? { text: t("agent.mode.checkNothing"), alert: false }
          : check.kind === "started"
            ? { text: t("agent.mode.checkStarted", { count: check.count }), alert: false }
            : null
  const checking = check.kind === "checking"
  const checkDisabled = checking || check.kind === "unavailable"

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="agent-mode-trigger"
            aria-label={t("agent.mode.openLabel", { mode: label })}
            className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
          />
        }
      >
        <SlidersHorizontal aria-hidden className="h-3 w-3" />
        <span>{label}</span>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-80" data-testid="agent-mode-popover">
        <p className="text-xs font-medium text-foreground">{t("agent.mode.title")}</p>

        {loadFailed && (
          <p className="text-[11px] text-muted-foreground">{t("agent.mode.unavailable")}</p>
        )}
        {!loadFailed && !mode && (
          <p className="text-[11px] text-muted-foreground">{t("agent.mode.loading")}</p>
        )}

        {mode && (
          <>
            {/* Presets — shorthand for the switches below, never a fourth value. */}
            <section className="flex flex-col gap-1.5">
              <p className="text-[11px] font-medium text-foreground">
                {t("agent.mode.presetsTitle")}
              </p>
              <div className="flex flex-wrap gap-1">
                {AGENT_MODE_PRESETS.map((preset) => {
                  const active = selectedPreset === preset.id
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      disabled={!canEdit}
                      aria-pressed={active}
                      title={t(preset.descriptionKey)}
                      onClick={() => save(preset.mode)}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-50",
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border text-muted-foreground hover:bg-accent",
                      )}
                    >
                      {t(preset.nameKey)}
                    </button>
                  )
                })}
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t(agentModeDescriptionKey(mode))}
              </p>
            </section>

            {/* The two loops the presets are shorthand for. */}
            <section className="flex flex-col gap-2">
              <ModeSwitch
                id="agent-mode-initiative"
                label={t("agent.mode.initiative")}
                description={t("agent.mode.initiativeDescription")}
                checked={mode.initiative}
                disabled={!canEdit}
                onChange={(checked) => save({ ...mode, initiative: checked })}
              />
              <ModeSwitch
                id="agent-mode-react"
                label={t("agent.mode.react")}
                description={t("agent.mode.reactDescription")}
                checked={mode.react}
                disabled={!canEdit}
                onChange={(checked) => save({ ...mode, react: checked })}
              />
            </section>

            {/* Scope. A segmented radio group rather than a Select: three
                short options, and no popup nested inside this popup. */}
            <section className="flex flex-col gap-1.5">
              <p className="text-[11px] font-medium text-foreground">
                {t("agent.mode.scopeTitle")}
              </p>
              <div
                role="radiogroup"
                aria-label={t("agent.mode.scopeTitle")}
                className="flex overflow-hidden rounded-md border"
              >
                {AGENT_MODE_SCOPES.map((scope) => {
                  const active = mode.scope === scope
                  return (
                    <button
                      key={scope}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={!canEdit}
                      onClick={() => save({ ...mode, scope })}
                      className={cn(
                        "flex-1 border-e px-2 py-1 text-[11px] transition-colors last:border-e-0 disabled:opacity-50",
                        active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50",
                      )}
                    >
                      {t(SCOPE_LABEL_KEYS[scope])}
                    </button>
                  )
                })}
              </div>
            </section>

            {!canEdit && (
              <p className="text-[11px] text-muted-foreground">{t("agent.mode.forbidden")}</p>
            )}
            {saveError && (
              <p role="alert" className="text-[11px] text-destructive">
                {saveError}
              </p>
            )}

            {/* View-first: what the dial actually turns on, as the same graph
                the activity inspector draws. No overview to hand it here —
                compact mode renders the shape without live state. */}
            <section className="flex flex-col gap-1">
              <p className="text-[11px] font-medium text-foreground">
                {t("agent.mode.graphTitle")}
              </p>
              <AutopilotProcessGraph compact />
            </section>

            {canCheck && (
              <section className="flex flex-col gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="justify-start"
                  disabled={checkDisabled}
                  onClick={runCheck}
                >
                  <Zap data-icon="inline-start" aria-hidden />
                  {checking ? t("agent.mode.checking") : t("agent.mode.checkNow")}
                </Button>
                {checkNote && (
                  <p
                    role={checkNote.alert ? "alert" : undefined}
                    className={cn(
                      "text-[11px]",
                      checkNote.alert ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {checkNote.text}
                  </p>
                )}
              </section>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

function ModeSwitch({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  // Labelled by the visible text rather than a duplicated aria-label, so the
  // name a screen reader announces can never drift from the one on screen.
  // Stated explicitly: base-ui reassigns the `id` prop internally, so the
  // association has to be written out rather than derived from it.
  return (
    <div className="flex items-start gap-2">
      <Switch
        size="sm"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        onCheckedChange={onChange}
      />
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-[11px] font-medium text-foreground">
          {label}
        </p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
