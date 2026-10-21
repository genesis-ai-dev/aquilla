// AQU-2068: the one AI % meter (spec §6). Every surface — org overview,
// billing settings, personal usage, the agent dock — renders this, so a tier
// looks the same wherever it is seen. It shows a percentage and when it
// resets; it never shows credits, words or dollars (R7).

import { useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { Gem, Info, KeyRound, Sparkles } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { AppTooltip } from "@/components/ui/tooltip"
import { useAiMeter } from "@/hooks/useAiMeter"
import { METER_WARNING_PERCENT, meterView, type MeterView } from "@/lib/billing/ai-meter"
import { useT } from "@/lib/i18n/I18nProvider"
import { orgSettingsPath } from "@/lib/navigation/org-paths"
import { cn } from "@/lib/utils"
import "./ai-meter.css"

export interface AiMeterProps {
  view: MeterView
  orgId: number
  /** Admins get the upgrade/key CTAs; members are told to ask an admin. */
  canManage: boolean
  /** Inside a project: opens the AI setup dialog. Elsewhere the CTA links to
   *  the org's AI provider keys (the BYOK screen is AQU-2015). */
  onUseOwnKey?: () => void
  /** Near agent actions: says agent runs drain the allowance faster. */
  agent?: boolean
  className?: string
}

function resetDay(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(undefined, { weekday: "short" })
}

export function AiMeter({ view, orgId, canManage, onUseOwnKey, agent = false, className }: AiMeterProps) {
  const t = useT()
  if (view.kind === "loading") {
    return <MeterFrame className={className}><p className="text-sm text-muted-foreground" role="status">{t("billing.meter.loading")}</p></MeterFrame>
  }
  if (view.kind === "unavailable") {
    return <MeterFrame className={className}><p className="text-sm text-muted-foreground" role="status">{t("billing.meter.unavailable")}</p></MeterFrame>
  }
  if (view.kind === "unlimited") {
    return (
      <MeterFrame className={className} state="unlimited" aside={<EnterpriseBadge />}>
        <p className="ai-meter-unlimited text-3xl font-semibold tracking-tight">{t("billing.meter.unlimited")}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t("billing.meter.unlimitedHelp")}</p>
      </MeterFrame>
    )
  }
  if (view.kind === "byok") {
    return (
      <MeterFrame className={className} state="byok" aside={
        <AppTooltip content={t("billing.meter.byokTooltip")}>
          <button type="button" className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground" aria-label={t("billing.meter.byokInfoAriaLabel")}>
            <Info className="size-4" />
          </button>
        </AppTooltip>
      }>
        <p className="text-3xl font-semibold tracking-tight text-muted-foreground/70">{t("billing.meter.byok")}</p>
        <div className="mt-3 h-2 rounded-full bg-foreground/5 text-muted-foreground ai-meter-hatched" aria-hidden data-testid="ai-meter-track" />
      </MeterFrame>
    )
  }

  const day = resetDay(view.resetsAt)
  return (
    <MeterFrame className={className} state={view.level} aside={day ? <span className="text-xs text-muted-foreground">{t("billing.meter.resets", { day })}</span> : null}>
      <p className={cn("text-3xl font-semibold tabular-nums tracking-tight", view.level === "exhausted" && "text-destructive")}>
        {t("billing.meter.percent", { percent: view.percent })}
      </p>
      <MeterBar percent={view.percent} level={view.level} />
      {view.level === "warning" ? (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-400" role="status">{t("billing.meter.warning")}</p>
      ) : null}
      {view.level === "exhausted" ? (
        <ExhaustedActions tier={view.tier} day={day} orgId={orgId} canManage={canManage} onUseOwnKey={onUseOwnKey} />
      ) : null}
      {agent ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="ai-meter-agent-note">
          <Sparkles className="mt-0.5 size-3.5 shrink-0" />{t("billing.meter.agentNote")}
        </p>
      ) : null}
    </MeterFrame>
  )
}

function MeterFrame({ state, aside, className, children }: {
  state?: string; aside?: ReactNode; className?: string; children: ReactNode
}) {
  const t = useT()
  return (
    <div className={cn("flex flex-col", className)} data-testid="ai-meter" data-state={state}>
      <div className="mb-1.5 flex min-h-6 items-center justify-between gap-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{t("billing.meter.label")}</span>
        {aside}
      </div>
      {children}
    </div>
  )
}

const FILL: Record<"ok" | "warning" | "exhausted", string> = {
  ok: "bg-primary",
  warning: "bg-amber-500",
  exhausted: "bg-destructive",
}

function MeterBar({ percent, level }: { percent: number; level: "ok" | "warning" | "exhausted" }) {
  const t = useT()
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label={t("billing.meter.ariaLabel", { percent })}
      className="relative mt-3 h-2 rounded-full bg-foreground/10"
    >
      <div className={cn("h-full rounded-full transition-[width] duration-500 ease-out", FILL[level])} style={{ width: `${percent}%` }} />
      {/* Where the warning starts, so 78% reads as "close", not "fine". */}
      <span aria-hidden className="absolute inset-y-[-2px] w-px bg-foreground/20" style={{ left: `${METER_WARNING_PERCENT}%` }} />
    </div>
  )
}

function ExhaustedActions({ tier, day, orgId, canManage, onUseOwnKey }: {
  tier: "free" | "team"; day: string | null; orgId: number; canManage: boolean; onUseOwnKey?: () => void
}) {
  const t = useT()
  const ownKey = onUseOwnKey ? (
    <Button size="sm" variant="outline" onClick={onUseOwnKey}><KeyRound data-icon="inline-start" />{t("billing.meter.ownKey")}</Button>
  ) : (
    <Link to={orgSettingsPath(orgId, "providers")} className={cn(buttonVariants({ size: "sm", variant: "outline" }))}>
      <KeyRound data-icon="inline-start" />{t("billing.meter.ownKey")}
    </Link>
  )
  return (
    <div className="mt-3 flex flex-col gap-3" data-testid="ai-meter-exhausted">
      <p className="text-sm" role="alert">
        {day ? t("billing.meter.exhausted", { day }) : t("billing.meter.exhaustedNoDate")}
      </p>
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          {tier === "free" ? (
            <Link to={orgSettingsPath(orgId, "billing")} className={cn(buttonVariants({ size: "sm" }))}>{t("billing.meter.upgrade")}</Link>
          ) : null}
          {ownKey}
          {tier === "team" ? (
            <a href="mailto:hello@aquilla.app?subject=Aquilla%20Enterprise" className={cn(buttonVariants({ size: "sm", variant: "ghost" }))}>{t("billing.meter.enterpriseContact")}</a>
          ) : null}
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{t("billing.meter.askAdmin")}</p>
          {onUseOwnKey ? <div>{ownKey}</div> : null}
        </>
      )}
    </div>
  )
}

/** The quiet premium mark: a dark card chip with a champagne hairline. */
export function EnterpriseBadge({ className }: { className?: string }) {
  const t = useT()
  return (
    <span className={cn("ai-meter-premium inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.12em]", className)} data-testid="enterprise-badge">
      <Gem className="size-3 text-[var(--ai-meter-gold)]" aria-hidden />
      {t("billing.meter.enterprise")}
    </span>
  )
}

/** Fetches the org's meter and renders it. */
export function OrgAiMeter({ jwt, orgId, refreshKey, ...props }: Omit<AiMeterProps, "view"> & { jwt: string; refreshKey?: number }) {
  const data = useAiMeter(jwt, orgId, refreshKey)
  return <AiMeter view={meterView(data)} orgId={orgId} {...props} />
}

/** The compact form near AI actions: a ring that opens the full meter. */
export function AiMeterCompact({ view, ...props }: AiMeterProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  if (view.kind === "loading" || view.kind === "unavailable") return null
  const label = view.kind === "unlimited" ? t("billing.meter.unlimited")
    : view.kind === "byok" ? t("billing.meter.byok")
    : t("billing.meter.ariaLabel", { percent: view.percent })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <AppTooltip content={label} disabled={open}>
        <PopoverTrigger
          render={
            <button
              type="button"
              data-testid="ai-meter-compact"
              data-state={view.kind === "metered" ? view.level : view.kind}
              aria-label={label}
              className="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-foreground"
            />
          }
        >
          {view.kind === "unlimited" ? <Gem className="size-4 text-[#a98a52] dark:text-[#d8bd86]" />
            : <MeterRing percent={view.kind === "metered" ? view.percent : 0} level={view.kind === "metered" ? view.level : null} />}
        </PopoverTrigger>
      </AppTooltip>
      <PopoverContent side="top" align="start" className="w-72 p-4">
        <AiMeter view={view} {...props} />
      </PopoverContent>
    </Popover>
  )
}

const RING: Record<"ok" | "warning" | "exhausted", string> = {
  ok: "stroke-primary",
  warning: "stroke-amber-500",
  exhausted: "stroke-destructive",
}

/** 16px ring; `level` null is the greyed BYOK ring (dashed, empty). */
function MeterRing({ percent, level }: { percent: number; level: "ok" | "warning" | "exhausted" | null }) {
  const stroke = 2.5
  const r = (12 - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 12 12" className="size-4 -rotate-90" aria-hidden>
      <circle cx="6" cy="6" r={r} fill="none" strokeWidth={stroke} className="stroke-muted-foreground/25" strokeDasharray={level ? undefined : "1.5 1.5"} />
      {level ? (
        <circle cx="6" cy="6" r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${(percent / 100) * c} ${c}`} className={RING[level]} />
      ) : null}
    </svg>
  )
}
