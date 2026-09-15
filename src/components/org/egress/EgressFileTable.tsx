// Data egress file explorer — every file across the org's projects, with a
// quick filter and checkbox selection. Selection is a lifted Set<string> of
// fileIds (AssignWork precedent); the header checkbox is tri-state over the
// FILTERED rows so "select all" while filtered scopes the bulk toggle to what
// the user is looking at, never silently clearing selections outside the
// filter.

import { useMemo } from "react"
import { type ColumnDef, type FilterFn } from "@tanstack/react-table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { laneChipLabel } from "@/components/org/project-lanes"
import type { EgressFileRow } from "@/hooks/useOrgEgressData"
import { useT } from "@/lib/i18n/I18nProvider"

const globalFilterFn: FilterFn<EgressFileRow> = (row, _columnId, filterValue) => {
  const q = String(filterValue ?? "").trim().toLowerCase()
  if (!q) return true
  const r = row.original
  return (
    r.fileName.toLowerCase().includes(q) ||
    r.projectName.toLowerCase().includes(q) ||
    r.fileType.toLowerCase().includes(q)
  )
}

export function EgressFileTable({
  rows,
  selected,
  onSelectedChange,
}: {
  rows: EgressFileRow[]
  selected: Set<string>
  onSelectedChange: (next: Set<string>) => void
}) {
  const t = useT()
  const columns = useMemo<ColumnDef<EgressFileRow>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        header: ({ table }) => {
          // Tri-state over the FILTERED row model: bulk toggle only what the
          // active quick filter shows.
          const filtered = table.getFilteredRowModel().rows
          const allSelected =
            filtered.length > 0 && filtered.every((r) => selected.has(r.original.fileId))
          const someSelected =
            !allSelected && filtered.some((r) => selected.has(r.original.fileId))
          return (
            <Checkbox
              aria-label={t("org.egress.selectAll")}
              checked={allSelected}
              indeterminate={someSelected}
              onCheckedChange={(checked) => {
                const next = new Set(selected)
                for (const r of filtered) {
                  if (checked === true) next.add(r.original.fileId)
                  else next.delete(r.original.fileId)
                }
                onSelectedChange(next)
              }}
              onClick={(e) => e.stopPropagation()}
            />
          )
        },
        cell: ({ row }) => (
          <Checkbox
            aria-label={t("org.egress.selectFile", { file: row.original.fileName })}
            checked={selected.has(row.original.fileId)}
            onCheckedChange={(checked) => {
              const next = new Set(selected)
              if (checked === true) next.add(row.original.fileId)
              else next.delete(row.original.fileId)
              onSelectedChange(next)
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ),
      },
      {
        id: "file",
        accessorKey: "fileName",
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.file")} />,
        cell: ({ row }) => (
          <span className="block max-w-64 truncate font-medium">{row.original.fileName}</span>
        ),
      },
      {
        id: "project",
        accessorKey: "projectName",
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.project")} />,
        cell: ({ row }) => (
          <span className="block max-w-48 truncate">{row.original.projectName}</span>
        ),
      },
      {
        id: "type",
        accessorKey: "fileType",
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("fileDetails.type")} />,
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">{row.original.fileType}</span>
        ),
      },
      {
        id: "cells",
        accessorKey: "cellCount",
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("org.projectOverview.cellsSuffix")} />,
        meta: { align: "right" },
        cell: ({ row }) => <span className="tabular-nums">{row.original.cellCount}</span>,
      },
      {
        id: "translated",
        accessorFn: (r) => r.filledCount ?? -1,
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("org.orgHome.table.translatedHeaderLabel")} />,
        meta: { align: "right" },
        cell: ({ row }) =>
          row.original.filledCount != null ? (
            <span className="tabular-nums">{row.original.filledCount}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "lanes",
        enableSorting: false,
        header: () => <span>{t("org.egress.column.lanes")}</span>,
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.lanes.map((l) => (
              <Badge key={l.lane || "__default"} variant="secondary" className="max-w-24 truncate">
                {laneChipLabel(l.lane, row.original.targetLanguage)}
              </Badge>
            ))}
          </div>
        ),
      },
      {
        id: "audio",
        accessorFn: (r) => (r.hasAudio ? 1 : 0),
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("nav.outbox.previewAudio")} />,
        cell: ({ row }) =>
          row.original.hasAudio ? (
            <Badge variant="outline">{t("nav.outbox.previewAudio")}</Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "edited",
        accessorFn: (r) => r.lastEditAt ?? 0,
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("org.egress.column.lastEdit")} />,
        cell: ({ row }) => (
          <DateTooltip value={row.original.lastEditAt} className="text-muted-foreground" />
        ),
      },
    ],
    [selected, onSelectedChange, t],
  )

  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(r) => r.fileId}
      initialSorting={[{ id: "project", desc: false }]}
      searchPlaceholder={t("org.egress.filterPlaceholder")}
      globalFilterFn={globalFilterFn}
      testId="egress-file-table"
      toolbar={
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm tabular-nums text-muted-foreground" data-testid="egress-selected-count">
            {t("org.egress.selectedCount", { selected: selected.size, total: rows.length })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={selected.size === 0}
            onClick={() => onSelectedChange(new Set())}
          >
            {t("editor.selection.clear")}
          </Button>
        </div>
      }
    />
  )
}
