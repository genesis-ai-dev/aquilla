import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { FolderOpen } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AdminDataTable, type AdminColumn } from "./AdminDataTable"
import { AttentionBadges, ValidatedBar } from "./shared"
import { fmtDate } from "@/lib/admin/format"
import { attentionReasons, attentionScore, validatedFraction } from "@/lib/admin/insights"
import type { AdminProject } from "@/lib/frontier/admin"

type Lens = "all" | "at-risk" | "active" | "archived"
const LENSES: { value: Lens; label: string }[] = [
  { value: "all", label: "All" },
  { value: "at-risk", label: "At risk" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
]

/**
 * Projects — searchable, sortable, and filterable by a lens (all / at-risk /
 * active / archived). The Status column shows why a project needs attention
 * (overdue / due-soon / stalled) instead of a bare "Active", turning the old
 * flat table into something an operator can triage from.
 */
export function AdminProjectsSection({ projects }: { projects: AdminProject[] }) {
  const [now] = useState(() => Date.now())
  const [lens, setLens] = useState<Lens>("all")

  const rows = useMemo(() => {
    switch (lens) {
      case "at-risk":
        return projects.filter((p) => !p.archived && attentionReasons(p, now).length > 0)
      case "active":
        return projects.filter((p) => !p.archived)
      case "archived":
        return projects.filter((p) => p.archived)
      default:
        return projects
    }
  }, [projects, lens, now])

  const columns: AdminColumn<AdminProject>[] = [
    {
      key: "name",
      header: "Project",
      sortValue: (p) => p.name.toLowerCase(),
      render: (p) =>
        p.archived ? (
          <span className="text-muted-foreground">{p.name}</span>
        ) : (
          <Link to={`/projects/${p.id}`} className="font-medium text-primary hover:underline">
            {p.name}
          </Link>
        ),
    },
    { key: "org", header: "Org", sortValue: (p) => (p.orgName ?? "").toLowerCase(), render: (p) => p.orgName ?? "—" },
    {
      key: "creator",
      header: "Creator",
      sortValue: (p) => (p.creatorUsername ?? "").toLowerCase(),
      render: (p) => p.creatorUsername ?? "—",
    },
    {
      key: "validated",
      header: "Validated",
      sortValue: (p) => validatedFraction(p),
      render: (p) => <ValidatedBar fraction={validatedFraction(p)} />,
    },
    {
      key: "words",
      header: "Words",
      align: "right",
      sortValue: (p) => p.wordCount,
      render: (p) => p.wordCount.toLocaleString(),
    },
    {
      key: "edited",
      header: "Last edit",
      sortValue: (p) => p.lastEditAt ?? null,
      render: (p) => (p.lastEditAt ? fmtDate(new Date(p.lastEditAt).toISOString()) : "—"),
    },
    {
      key: "status",
      header: "Status",
      sortValue: (p) => (p.archived ? -1 : attentionScore(p, now)),
      render: (p) => {
        if (p.archived) return <Badge variant="secondary">Archived</Badge>
        const reasons = attentionReasons(p, now)
        return reasons.length > 0 ? (
          <AttentionBadges reasons={reasons} />
        ) : (
          <Badge variant="outline" className="text-emerald-600 dark:text-emerald-400">
            On track
          </Badge>
        )
      },
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1">
        {LENSES.map((l) => (
          <Button
            key={l.value}
            type="button"
            size="xs"
            variant={lens === l.value ? "default" : "secondary"}
            onClick={() => setLens(l.value)}
          >
            {l.label}
          </Button>
        ))}
      </div>

      <AdminDataTable
        columns={columns}
        rows={rows}
        getRowKey={(p) => p.id}
        searchText={(p) => `${p.name} ${p.orgName ?? ""} ${p.creatorUsername ?? ""}`}
        searchPlaceholder="Search projects…"
        initialSort={{ key: "status", dir: "desc" }}
        empty={{
          icon: FolderOpen,
          title: lens === "at-risk" ? "Nothing at risk" : "No projects",
          description:
            lens === "at-risk"
              ? "No active project is overdue, due soon, or stalled."
              : "Projects appear here as they're created.",
        }}
        testId="admin-projects-table"
      />
    </div>
  )
}
