import { useId, useMemo, useState } from "react"
import { CircleHelp } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useI18n, type TFunction } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import {
  PROCESS_EDGES,
  PROCESS_NODE_LAYOUT,
  PROCESS_NODE_SIZE,
  PROCESS_VIEWBOX,
  deriveProcessGraph,
  deriveProcessGraphFromOverview,
  layoutById,
  type ProcessDecision,
  type ProcessEdge,
  type ProcessGraphModel,
  type ProcessNodeId,
  type ProcessNodeInspect,
  type ProcessNodeLayout,
  type ProcessNodeState,
} from "@/lib/contextual/process-graph"
import { joinPassageLabels } from "../../../shared/span-label"
import type {
  ContextualOverview,
  ContextualRunActivity,
  ContextualRunRecord,
} from "@/lib/contextual/transport"

const NODE_COPY = {
  scope: { label: "autopilot.graph.node.scope", role: "autopilot.graph.node.scope.role" },
  segment: { label: "autopilot.graph.node.segment", role: "autopilot.graph.node.segment.role" },
  construe: { label: "autopilot.graph.node.construe", role: "autopilot.graph.node.construe.role" },
  expand_window: { label: "autopilot.graph.node.expand_window", role: "autopilot.graph.node.expand_window.role" },
  register: { label: "autopilot.graph.node.register", role: "autopilot.graph.node.register.role" },
  summarize: { label: "autopilot.graph.node.summarize", role: "autopilot.graph.node.summarize.role" },
  persist: { label: "autopilot.graph.node.persist", role: "autopilot.graph.node.persist.role" },
  draft: { label: "autopilot.graph.node.draft", role: "autopilot.graph.node.draft.role" },
  lint_rules: { label: "autopilot.graph.node.lint_rules", role: "autopilot.graph.node.lint_rules.role" },
  route_risk: { label: "autopilot.graph.node.route_risk", role: "autopilot.graph.node.route_risk.role" },
  verify_force: { label: "autopilot.graph.node.verify_force", role: "autopilot.graph.node.verify_force.role" },
  verify_ambiguity: { label: "autopilot.graph.node.verify_ambiguity", role: "autopilot.graph.node.verify_ambiguity.role" },
  verify_naturalness: { label: "autopilot.graph.node.verify_naturalness", role: "autopilot.graph.node.verify_naturalness.role" },
  quorum: { label: "autopilot.graph.node.quorum", role: "autopilot.graph.node.quorum.role" },
  stage: { label: "autopilot.graph.node.stage", role: "autopilot.graph.node.stage.role" },
  report: { label: "autopilot.graph.node.report", role: "autopilot.graph.node.report.role" },
} as const satisfies Record<ProcessNodeId, { label: MessageKey; role: MessageKey }>

function spanName(label: string | null | undefined, t: TFunction): string {
  return label?.trim() || t("autopilot.graph.thisSpan")
}

function decisionLine(decision: ProcessDecision | null, t: TFunction): string | null {
  if (!decision) return null
  const span = spanName(decision.spanLabel, t)
  if (decision.kind === "ambiguities") {
    return decision.count == null
      ? t("autopilot.graph.decision.ambiguitiesUncounted", { span })
      : t("autopilot.graph.decision.ambiguities", { count: decision.count, span })
  }
  if (decision.kind === "drafts") {
    return decision.count == null
      ? t("autopilot.graph.decision.draftsUncounted", { span })
      : t("autopilot.graph.decision.drafts", { count: decision.count, span })
  }
  if (decision.kind === "outcome") {
    if (decision.status === "failed") return t("autopilot.graph.decision.outcomeFailed", { span })
    if (decision.status === "partial") return t("autopilot.graph.decision.outcomePartial", { span })
    return t("autopilot.graph.decision.outcomeDone", { span })
  }
  return t("autopilot.graph.decision.phase", { span })
}

function insetToward(
  from: ProcessNodeLayout,
  to: ProcessNodeLayout,
  inset: number,
): { x: number; y: number } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy) || 1
  const travel = Math.min(inset, len / 2.4)
  return { x: from.x + (dx / len) * travel, y: from.y + (dy / len) * travel }
}

function edgePath(from: ProcessNodeLayout, to: ProcessNodeLayout, edge: ProcessEdge): string {
  const start = insetToward(from, to, PROCESS_NODE_SIZE * 0.86)
  const end = insetToward(to, from, PROCESS_NODE_SIZE * 0.86)
  if (edge.kind === "loop") {
    const midX = (start.x + end.x) / 2
    return `M ${start.x} ${start.y} Q ${midX} ${Math.min(start.y, end.y) - 7} ${end.x} ${end.y}`
  }
  if (edge.kind === "redraft") {
    const midX = (start.x + end.x) / 2
    return `M ${start.x} ${start.y} Q ${midX} ${Math.max(start.y, end.y) + 8} ${end.x} ${end.y}`
  }
  if (start.y !== end.y) {
    const midX = (start.x + end.x) / 2
    const midY = (start.y + end.y) / 2
    return `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${midY}, ${end.x} ${end.y}`
  }
  return `M ${start.x} ${start.y} L ${end.x} ${end.y}`
}

function nodeFill(state: ProcessNodeState): string {
  if (state === "active") return "var(--primary)"
  if (state === "failed") return "color-mix(in oklab, var(--destructive) 55%, var(--background))"
  if (state === "done") return "color-mix(in oklab, var(--foreground) 16%, var(--background))"
  return "transparent"
}

function nodeStroke(state: ProcessNodeState): string {
  if (state === "active") return "var(--primary)"
  if (state === "failed") return "var(--destructive)"
  if (state === "done") return "color-mix(in oklab, var(--foreground) 22%, var(--background))"
  return "color-mix(in oklab, var(--muted-foreground) 38%, transparent)"
}

function edgeStroke(state: ProcessNodeState, kind: ProcessEdge["kind"] = "flow"): string {
  const faint = kind === "loop" || kind === "redraft"
  if (state === "active") return faint
    ? "color-mix(in oklab, var(--primary) 70%, transparent)"
    : "var(--primary)"
  if (state === "failed") return "var(--destructive)"
  if (state === "done") {
    return faint
      ? "color-mix(in oklab, var(--foreground) 22%, transparent)"
      : "color-mix(in oklab, var(--foreground) 28%, transparent)"
  }
  return faint
    ? "color-mix(in oklab, var(--muted-foreground) 22%, transparent)"
    : "color-mix(in oklab, var(--muted-foreground) 32%, transparent)"
}

function HoverBody({ inspect, t }: { inspect: ProcessNodeInspect; t: TFunction }) {
  const copy = NODE_COPY[inspect.nodeId]
  const decision = decisionLine(inspect.decision, t)
  const brief = inspect.sceneBrief?.l1Summary ?? inspect.sceneBrief?.construal
  const passage = joinPassageLabels(inspect.spanLabels)
  return (
    <div className="flex max-w-xs flex-col gap-1.5 text-start">
      <p className="font-medium">{t(copy.label)}</p>
      <p className="text-muted-foreground">{t(copy.role)}</p>
      {passage && <p>{passage}</p>}
      {brief && <p className="line-clamp-3 text-muted-foreground">{brief}</p>}
      {decision && <p>{decision}</p>}
    </div>
  )
}

function GraphSvg({
  model,
  compact,
  selectedId,
  onSelect,
  t,
}: {
  model: ProcessGraphModel
  compact: boolean
  selectedId: ProcessNodeId | null
  onSelect?: (id: ProcessNodeId) => void
  t: TFunction
}) {
  const reactId = useId().replace(/:/g, "")
  const positions = layoutById()
  const size = compact ? PROCESS_NODE_SIZE - 1 : PROCESS_NODE_SIZE
  const radius = size / 2
  const markerPrefix = `${compact ? "mini" : "full"}-${reactId}`
  const hit = `${((size + 6) / PROCESS_VIEWBOX.width) * 100}%`
  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${PROCESS_VIEWBOX.width} ${PROCESS_VIEWBOX.height}`}
        role="img"
        aria-label={t("autopilot.graph.aria")}
        data-testid={compact ? "autopilot-process-graph-mini" : "autopilot-process-graph"}
        className="h-auto w-full overflow-visible"
      >
        <style>{`
          @keyframes autopilot-edge-dash { to { stroke-dashoffset: -14; } }
          @keyframes autopilot-node-pulse { 50% { opacity: 0.72; } }
          @media (prefers-reduced-motion: no-preference) {
            .autopilot-edge-live { animation: autopilot-edge-dash 1.2s linear infinite; }
            .autopilot-node-live { animation: autopilot-node-pulse 1.2s ease-in-out infinite; }
          }
        `}</style>
        <defs>
          {(["pending", "active", "done", "failed"] as const).map((state) => (
            <marker
              key={state}
              id={`autopilot-graph-chevron-${markerPrefix}-${state}`}
              viewBox="0 0 6 6"
              refX="5.2"
              refY="3"
              markerWidth="2.2"
              markerHeight="2.2"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path
                d="M 1.4 1.2 L 4.8 3 L 1.4 4.8"
                fill="none"
                stroke={edgeStroke(state)}
                strokeWidth="1"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </marker>
          ))}
        </defs>
        {PROCESS_EDGES.map((edge) => {
          const state = model.edgeStates[edge.id] ?? "pending"
          const dashed = edge.kind === "loop" || edge.kind === "redraft"
          const live = state === "active" && !dashed
          return (
            <path
              key={edge.id}
              d={edgePath(positions[edge.from], positions[edge.to], edge)}
              fill="none"
              stroke={edgeStroke(state, edge.kind)}
              strokeWidth={1}
              strokeLinecap="round"
              strokeDasharray={dashed ? "1.6 2.6" : live ? "2.8 4.2" : undefined}
              markerEnd={dashed ? undefined : `url(#autopilot-graph-chevron-${markerPrefix}-${state})`}
              className={cn(live && "autopilot-edge-live")}
              vectorEffect="non-scaling-stroke"
            />
          )
        })}
        {PROCESS_NODE_LAYOUT.map((node) => {
          const state = model.nodeStates[node.id]
          const selected = selectedId === node.id
          return (
            <g key={node.id}>
              {selected && (
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={radius + 2.2}
                  fill="none"
                  stroke="var(--foreground)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <circle
                cx={node.x}
                cy={node.y}
                r={radius}
                fill={nodeFill(state)}
                stroke={nodeStroke(state)}
                strokeWidth={1}
                className={cn(state === "active" && "autopilot-node-live")}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          )
        })}
      </svg>
      {PROCESS_NODE_LAYOUT.map((node) => {
        const inspect = model.inspect[node.id]
        const selected = selectedId === node.id
        return (
          <AppTooltip
            key={node.id}
            delay={200}
            content={<HoverBody inspect={inspect} t={t} />}
            className="max-w-xs"
          >
            <button
              type="button"
              aria-label={t(NODE_COPY[node.id].label)}
              aria-pressed={onSelect ? selected : undefined}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-0 bg-transparent p-0"
              style={{
                left: `${(node.x / PROCESS_VIEWBOX.width) * 100}%`,
                top: `${(node.y / PROCESS_VIEWBOX.height) * 100}%`,
                width: hit,
                aspectRatio: "1",
              }}
              onClick={() => onSelect?.(node.id)}
            />
          </AppTooltip>
        )
      })}
    </div>
  )
}

function InspectPanel({
  inspect,
  t,
  onClose,
}: {
  inspect: ProcessNodeInspect
  t: TFunction
  onClose: () => void
}) {
  const copy = NODE_COPY[inspect.nodeId]
  const decision = decisionLine(inspect.decision, t)
  const brief = inspect.sceneBrief?.l1Summary ?? inspect.sceneBrief?.construal
  const ambiguities = Array.isArray(inspect.sceneBrief?.ambiguityRegister)
    ? inspect.sceneBrief.ambiguityRegister
    : []
  return (
    <Card size="sm" data-testid="autopilot-process-graph-inspect">
      <CardHeader>
        <CardTitle>{t(copy.label)}</CardTitle>
        <CardAction>
          <Button type="button" size="xs" variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <p className="text-muted-foreground">{t(copy.role)}</p>
        <div>
          <p className="text-xs font-medium">{t("autopilot.graph.inspect.passage")}</p>
          <p>{joinPassageLabels(inspect.spanLabels) ?? t("autopilot.graph.noLiveSpan")}</p>
        </div>
        <div>
          <p className="text-xs font-medium">{t("autopilot.graph.inspect.brief")}</p>
          <p className="whitespace-pre-wrap text-muted-foreground">
            {brief || t("autopilot.graph.inspect.noBrief")}
          </p>
          {ambiguities.length > 0 && (
            <ul className="mt-1 list-disc ps-4 text-muted-foreground">
              {ambiguities.map((item, index) => (
                <li key={item.id ?? index}>
                  {item.question ?? t("autopilot.inspector.context.unlabelledAmbiguity")}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-xs font-medium">{t("autopilot.graph.inspect.decision")}</p>
          <p className="text-muted-foreground">{decision ?? t("autopilot.graph.inspect.noDecision")}</p>
          {inspect.decision?.reasons && inspect.decision.reasons.length > 0 && (
            <p className="text-xs text-muted-foreground">{inspect.decision.reasons.join(" · ")}</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function AutopilotProcessGraph({
  run,
  activity,
  overview,
  compact = false,
}: {
  run?: ContextualRunRecord | null
  activity?: ContextualRunActivity | null
  overview?: ContextualOverview | null
  compact?: boolean
}) {
  const { locale, t } = useI18n()
  const [selectedId, setSelectedId] = useState<ProcessNodeId | null>(null)
  const model = useMemo(
    () => (compact && !activity && !run
      ? deriveProcessGraphFromOverview(overview)
      : deriveProcessGraph(run, activity)),
    [activity, compact, overview, run],
  )
  const liveLine = model.liveSpanLabels.length > 0
    ? t("autopilot.graph.liveSpans", {
      spans: new Intl.ListFormat(locale, { style: "narrow", type: "conjunction" })
        .format(model.liveSpanLabels),
    })
    : t("autopilot.graph.noLiveSpan")
  const lastDecision = decisionLine(model.lastDecision, t)
  const selected = selectedId ? model.inspect[selectedId] : null

  if (compact) {
    return (
      <div className="flex flex-col gap-1" data-testid="autopilot-process-graph-card">
        <GraphSvg model={model} compact selectedId={null} t={t} />
      </div>
    )
  }

  return (
    <section aria-labelledby="autopilot-graph-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="autopilot-graph-title" className="text-sm font-medium">
          {t("autopilot.graph.title")}
        </h3>
        <AppTooltip content={t("autopilot.graph.spanHelp")} delay={200}>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label={t("autopilot.graph.spanHelpAria")}
            className="text-muted-foreground"
          >
            <CircleHelp data-icon="inline-start" aria-hidden />
          </Button>
        </AppTooltip>
        {model.live && <Badge variant="default">{t("autopilot.status.working")}</Badge>}
      </div>
      <p className="text-sm">{liveLine}</p>
      {lastDecision && <p className="text-sm text-muted-foreground">{lastDecision}</p>}
      <p className="text-xs text-muted-foreground">{t("autopilot.graph.inspectHint")}</p>
      <GraphSvg
        model={model}
        compact={false}
        selectedId={selectedId}
        onSelect={(id) => setSelectedId((current) => current === id ? null : id)}
        t={t}
      />
      {selected && (
        <InspectPanel inspect={selected} t={t} onClose={() => setSelectedId(null)} />
      )}
    </section>
  )
}
