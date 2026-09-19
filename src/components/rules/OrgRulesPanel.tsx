/**
 * OrgRulesPanel — the org-scoped rule library (AQU-1131).
 *
 * This block used to be inlined in `RulesSurface`, which meant org rules were
 * only reachable by opening SOME project's Living Memory → Translation quality
 * pane. AQU-1131: org rules are an org-level concern, so the same panel now
 * also renders standalone at `/orgs/:orgId/settings/rules`. One implementation,
 * two mount points — RulesSurface keeps its project context, the settings page
 * passes none.
 *
 * `cells` only feeds RuleEditor's live match preview. At org scope there is no
 * single project to preview against, so it defaults to empty and the editor
 * simply reports no matches.
 */
import { useState } from "react"
import { Building2, Clock, Lock, Pencil, Plus, Trash2 } from "lucide-react"
import { v4 as uuid } from "uuid"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { EmptyState } from "@/components/ui/page"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { AppTooltip } from "@/components/ui/tooltip"
import { RuleEditor } from "@/components/RuleEditor"
import { SeverityBadge, SeverityIcon } from "@/components/rules/RuleSeverity"
import type { CellData } from "@/hooks/useCells"
import { useT } from "@/lib/i18n/I18nProvider"
import type { PromotionRequest, TranslationRule } from "@/lib/parsers/types"
import type { OrgPatchResult, OrgWideSettings } from "@/lib/sync/org-settings"

export interface OrgRulesPanelProps {
  orgRules: TranslationRule[]
  /** Caller's org role is >= MAINTAINER (see useOrgSettings.canEdit). */
  canEdit: boolean
  patchOrgSettings?: (partial: OrgWideSettings) => Promise<OrgPatchResult | { kind: "blocked" }>
  promotionRequests?: PromotionRequest[]
  /** Cells for RuleEditor's match preview. Empty at org scope. */
  cells?: CellData[]
  /**
   * Render nothing when there is no library and no way to start one. Right for
   * an embedded card competing for space in RulesSurface; wrong for the
   * standalone settings page, where a blank page would look broken — a viewer
   * there gets the empty state plus the read-only badge.
   */
  hideWhenEmpty?: boolean
}

export function OrgRulesPanel({
  orgRules,
  canEdit,
  patchOrgSettings,
  promotionRequests = [],
  cells = [],
  hideWhenEmpty = false,
}: OrgRulesPanelProps) {
  const t = useT()
  const [editingOrgRuleId, setEditingOrgRuleId] = useState<string | "new" | null>(null)

  async function updateOrgRule(ruleId: string, updates: Partial<TranslationRule>) {
    if (!patchOrgSettings) return
    const updated = orgRules.map((r) => r.id === ruleId ? { ...r, ...updates } : r)
    await patchOrgSettings({ rules: updated })
  }

  async function deleteOrgRule(ruleId: string) {
    if (!patchOrgSettings) return
    const updated = orgRules.filter((r) => r.id !== ruleId)
    await patchOrgSettings({ rules: updated })
  }

  async function addOrgRule(rule: Omit<TranslationRule, "id" | "createdAt">) {
    if (!patchOrgSettings) return
    const newRule: TranslationRule = { ...rule, id: uuid(), scope: "org", createdAt: new Date().toISOString() }
    await patchOrgSettings({ rules: [...orgRules, newRule] })
  }

  async function handleApproveRequest(req: PromotionRequest) {
    if (!patchOrgSettings) return
    const promoted: TranslationRule = {
      ...req.rule,
      id: uuid(),
      scope: "org",
      lane: undefined, // an org rule applies everywhere — drop any lane pin
      sourceProjectId: req.sourceProjectId,
      createdAt: new Date().toISOString(),
    }
    const newOrgRules = [...orgRules, promoted]
    const newPendingRequests = promotionRequests.filter((r) => r.id !== req.id)
    await patchOrgSettings({ rules: newOrgRules, promotionRequests: newPendingRequests })
  }

  async function handleDismissRequest(reqId: string) {
    if (!patchOrgSettings) return
    const newPendingRequests = promotionRequests.filter((r) => r.id !== reqId)
    await patchOrgSettings({ promotionRequests: newPendingRequests })
  }

  // Nothing to show and nothing to add — stay out of the way entirely.
  if (hideWhenEmpty && orgRules.length === 0 && !canEdit) return null

  return (
    <>
      {/* Create org rule — dialog, not inline */}
      <Dialog
        open={editingOrgRuleId === "new"}
        onOpenChange={(open) => { if (!open) setEditingOrgRuleId(null) }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-h-[90vh] max-w-2xl gap-0 overflow-y-auto p-0 sm:max-w-2xl"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t("rules.surface.createOrgRuleDialog.title")}</DialogTitle>
            <DialogDescription>{t("rules.surface.createOrgRuleDialog.description")}</DialogDescription>
          </DialogHeader>
          {/* shrink-0: the editor root clips its own overflow, so as a flex
              item it would shrink to the dialog height and hide its footer
              instead of letting DialogContent scroll. */}
          <RuleEditor
            className="shrink-0 rounded-none border-0"
            cells={cells}
            onSave={async (rule) => {
              await addOrgRule(rule)
              setEditingOrgRuleId(null)
            }}
            onCancel={() => setEditingOrgRuleId(null)}
          />
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Building2 className="size-4 text-muted-foreground" />
            <CardTitle>{t("rules.surface.orgRulesCardTitle", { count: orgRules.length })}</CardTitle>
            {canEdit && (
              <Button
                variant="outline"
                className="ms-auto"
                onClick={() => setEditingOrgRuleId("new")}
                disabled={editingOrgRuleId !== null}
              >
                <Plus className="size-4" aria-hidden />
                {t("rules.surface.addOrgRuleButton")}
              </Button>
            )}
            {!canEdit && (
              <Badge variant="secondary" className="ms-auto">
                <Lock data-icon="inline-start" />
                {t("common.readOnly")}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {orgRules.length === 0 ? (
            <EmptyState
              variant="inline"
              className="px-0 py-4"
              icon={Building2}
              title={t("rules.surface.noOrgRules.title")}
              description={t("rules.surface.noOrgRules.description")}
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {orgRules.map((rule) => (
                <li key={rule.id} className="rounded-md border p-3">
                  <div className="flex items-center gap-3">
                    <SeverityIcon severity={rule.severity} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{rule.name}</span>
                        <SeverityBadge severity={rule.severity} />
                        <Badge>{t("common.org")}</Badge>
                      </div>
                      {rule.description && <p className="mt-0.5 text-xs text-muted-foreground truncate">{rule.description}</p>}
                    </div>
                    {canEdit && (
                      <>
                        <AppTooltip content={t("rules.surface.editOrgRuleTooltip")}>
                          <Button
                            variant="ghost"
                            onClick={() => setEditingOrgRuleId(editingOrgRuleId === rule.id ? null : rule.id)}
                            disabled={editingOrgRuleId !== null && editingOrgRuleId !== rule.id}
                            aria-label={t("rules.surface.editOrgRuleTooltip")}
                          >
                            <Pencil />
                          </Button>
                        </AppTooltip>
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Switch
                            size="sm"
                            checked={rule.enabled}
                            onCheckedChange={(checked) => updateOrgRule(rule.id, { enabled: checked })}
                            aria-label={
                              rule.enabled
                                ? t("rules.surface.disableOrgRuleAriaLabel", { name: rule.name })
                                : t("rules.surface.enableOrgRuleAriaLabel", { name: rule.name })
                            }
                          />
                          {t("rules.surface.enabledLabel")}
                        </label>
                        <Button variant="ghost" onClick={() => deleteOrgRule(rule.id)}>
                          <Trash2 />
                        </Button>
                      </>
                    )}
                  </div>
                  {editingOrgRuleId === rule.id && canEdit && (
                    <>
                      <Separator className="my-3" />
                      <RuleEditor
                        initialRule={rule}
                        cells={cells}
                        onSave={async (updates) => {
                          await updateOrgRule(rule.id, updates)
                          setEditingOrgRuleId(null)
                        }}
                        onCancel={() => setEditingOrgRuleId(null)}
                      />
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canEdit && promotionRequests.length > 0 && (
            <>
              <Separator className="my-4" />
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Clock className="size-3.5" />
                {t("rules.surface.pendingRequests", { count: promotionRequests.length })}
              </p>
              <ul className="flex flex-col gap-2">
                {promotionRequests.map((req) => (
                  <li key={req.id} className="rounded-md border bg-muted/30 p-3">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{req.rule.name}</p>
                        {req.rule.description && (
                          <p className="mt-0.5 text-xs text-muted-foreground truncate">{req.rule.description}</p>
                        )}
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("rules.surface.requestedBy", {
                            requester: req.requestedByName ?? t("rules.surface.requestedByFallback", { userId: req.requestedBy }),
                          })}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <AppTooltip content={t("rules.surface.approveRequestTooltip")}>
                          <Button size="sm" onClick={() => handleApproveRequest(req)}>
                            {t("rules.surface.approveButton")}
                          </Button>
                        </AppTooltip>
                        <AppTooltip content={t("rules.surface.dismissRequestTooltip")}>
                          <Button size="sm" variant="ghost" onClick={() => handleDismissRequest(req.id)}>
                            {t("common.dismiss")}
                          </Button>
                        </AppTooltip>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </>
  )
}
