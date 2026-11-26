/**
 * AQU-1352 §3.6: org "People & access". AQU-2318 is the Places lens. AQU-2319
 * is the People lens: one roster, shared search, and the CSV / print export
 * that replaces Access audit. The read lives in `useOrgAccess`.
 */
import { useState } from "react"
import { Download, Printer } from "lucide-react"
import { useSearchParams } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { PeopleLens, PeoplePrintReport } from "@/components/org/access/PeopleLens"
import { PlacesLens } from "@/components/org/access/PlacesLens"
import { GiveAccessDialog } from "@/components/org/access/GiveAccessDialog"
import type { ScopeRef } from "@/lib/access/types"
import { orgAccessCsv } from "@/components/org/access/org-access-data"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { LoadingPanel } from "@/components/ui/loading-overlay"
import { Page, PageHeader } from "@/components/ui/page"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useActiveOrg } from "@/context/OrgContext"
import { useOrgAccess } from "@/hooks/useOrgAccess"
import {
  countPlaces,
  parseAccessLens,
  parsePeopleFilter,
  rosterCounts,
  selectRoster,
  type PeopleFilter,
} from "@/lib/access/people-lens"
import { downloadBlob } from "@/lib/export/export-service"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

const PRINT_CSS = `
.people-print-report { display: none; }
@media print {
  .people-lens-active .people-print-report { display: block; }
  body:has(.people-lens-active) [data-print-hide],
  body:has(.people-lens-active) aside,
  body:has(.people-lens-active) [data-slot="app-shell-header"],
  body:has(.people-lens-active) [data-slot="app-shell-sidebar-footer"] { display: none !important; }
  body:has(.people-lens-active) main { overflow: visible !important; height: auto !important; }
  .people-print-person { break-inside: avoid; }
  @page { margin: 16mm; }
}
`

const FILTER_LABEL = {
  everyone: "org.access.people.filterEveryone",
  members: "org.access.people.filterMembers",
  guests: "org.access.people.filterGuests",
  invites: "org.access.people.filterInvites",
  granters: "org.access.people.filterGranters",
  inactive: "org.access.people.filterInactive",
} as const

export function OrgAccessPage() {
  const t = useT()
  const { activeOrg } = useActiveOrg()
  const state = useOrgAccess()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState("")
  // AQU-2320: the Give access dialog, with the place it was opened from.
  const [giveAt, setGiveAt] = useState<ScopeRef | null>(null)
  const canGive = state.status === "ready" && Object.values(state.data.grantable ?? {}).some((g) => g.ok)
  const lens = parseAccessLens(params.get("lens"))
  const filter = parsePeopleFilter(params.get("people"))
  const now = state.status === "ready" ? state.asOf : 0
  const people = state.status === "ready" ? state.data.people : []
  const tree = state.status === "ready" ? state.data.tree : []
  const roster = selectRoster(people, { query, filter, now })
  const placeCounts = countPlaces(tree)
  const filterCounts = rosterCounts(people, query, now)

  const setLens = (next: "places" | "people") => {
    setParams((prev) => {
      const updated = new URLSearchParams(prev)
      if (next === "people") updated.set("lens", "people")
      else updated.delete("lens")
      return updated
    })
  }
  const setFilter = (next: PeopleFilter) => {
    setParams((prev) => {
      const updated = new URLSearchParams(prev)
      updated.set("lens", "people")
      if (next === "everyone") updated.delete("people")
      else updated.set("people", next)
      return updated
    })
  }
  const exportCsv = () => {
    if (state.status !== "ready") return
    const rows = lens === "people" ? selectRoster(state.data.people, { query, filter, now }) : state.data.people
    const blob = new Blob([orgAccessCsv(t, rows)], { type: "text/csv;charset=utf-8" })
    downloadBlob(blob, `${(activeOrg?.name ?? "org").replace(/[^\w-]+/g, "-")}-access.csv`)
  }

  const title = t("org.access.page.title")
  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={title} />}
      statusBar={null}
      main={
        <Page size="full">
          <style>{PRINT_CSS}</style>
          <PageHeader
            title={title}
            actions={
              <span data-print-hide className="flex items-center gap-2">
                {lens === "people" && (
                  <Button variant="outline" size="sm" onClick={() => window.print()} disabled={state.status !== "ready"}>
                    <Printer className="size-4" aria-hidden />
                    {t("org.accessAudit.print")}
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={exportCsv} disabled={state.status !== "ready"}>
                  <Download className="size-4" aria-hidden />
                  {t("terminology.editor.exportCsv")}
                </Button>
              </span>
            }
          />
          {state.status === "loading" ? (
            <LoadingPanel label={t("common.loading")} />
          ) : state.status === "error" ? (
            <p role="alert" className="text-sm text-muted-foreground">{t("org.access.page.loadError")}</p>
          ) : (
            <div className={cn("flex min-w-0 flex-col gap-3", lens === "people" && "people-lens-active")}>
              <div data-print-hide className="flex min-w-0 flex-col gap-3">
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("org.access.places.search")}
                  aria-label={t("org.access.places.search")}
                  className="max-w-sm"
                />
                <Tabs value={lens} onValueChange={(value) => setLens(value === "people" ? "people" : "places")}>
                  <TabsList>
                    <TabsTrigger value="places">{t("org.access.places.tab")}</TabsTrigger>
                    <TabsTrigger value="people">{t("org.overviewLaneTable.peopleColumn")}</TabsTrigger>
                  </TabsList>
                  <TabsContent value="places" className="mt-3">
                    {lens === "places" && (
                      <PlacesLens tree={state.data.tree} query={query} onGiveAccess={canGive ? setGiveAt : undefined} />
                    )}
                  </TabsContent>
                  <TabsContent value="people" className="mt-3">
                    {lens === "people" && (
                      <PeopleLens
                        people={roster}
                        placeCounts={placeCounts}
                        filter={filter}
                        filterCounts={filterCounts}
                        onFilter={setFilter}
                        orgId={activeOrg?.id ?? null}
                      />
                    )}
                  </TabsContent>
                </Tabs>
              </div>
              {activeOrg && (
                <GiveAccessDialog
                  open={giveAt != null}
                  onOpenChange={(open) => { if (!open) setGiveAt(null) }}
                  orgId={activeOrg.id}
                  payload={state.data}
                  initialPlace={giveAt ?? undefined}
                  onGranted={state.reload}
                />
              )}
              {lens === "people" && (
                <PeoplePrintReport
                  people={roster}
                  placeCounts={placeCounts}
                  orgName={activeOrg?.name ?? ""}
                  filterLabel={t(FILTER_LABEL[filter])}
                />
              )}
            </div>
          )}
        </Page>
      }
    />
  )
}
