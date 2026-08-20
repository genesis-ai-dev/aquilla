/**
 * AccessModelLegend — collapsible legend explaining the four grant paths
 * and the max-wins effective-role rule.
 *
 * Shown below the matrix header on demand (controlled by MembersMatrixView).
 */

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

interface AccessModelLegendProps {
  /** When true the legend body is visible. */
  open: boolean
  onToggle: () => void
}

const GRANT_PATHS: ReadonlyArray<{
  badge: string
  labelKey: MessageKey
  badgeClass: string
  descriptionKey: MessageKey
}> = [
  {
    badge: "D",
    labelKey: "org.accessModelLegend.direct.label",
    badgeClass: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
    descriptionKey: "org.accessModelLegend.direct.description",
  },
  {
    badge: "G",
    labelKey: "org.accessModelLegend.viaGroup.label",
    badgeClass: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
    descriptionKey: "org.accessModelLegend.viaGroup.description",
  },
  {
    badge: "O",
    labelKey: "org.accessModelLegend.orgWide.label",
    badgeClass: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    descriptionKey: "org.accessModelLegend.orgWide.description",
  },
  {
    badge: "C",
    labelKey: "org.accessModelLegend.creator.label",
    badgeClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
    descriptionKey: "org.accessModelLegend.creator.description",
  },
]

export function AccessModelLegend({ open, onToggle }: AccessModelLegendProps) {
  const { t } = useI18n()
  return (
    <div className="border-b bg-muted/20 text-xs">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-start text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        <span
          className={`inline-block transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          aria-hidden
        >
          ▶
        </span>
        <span>{t("org.accessModelLegend.heading")}</span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 px-3 pb-3 pt-1">
          {/* Grant-path table */}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-6">{t("org.accessModelLegend.badgeColumn")}</TableHead>
                <TableHead className="w-24">{t("org.accessModelLegend.pathColumn")}</TableHead>
                <TableHead>{t("org.accessModelLegend.meaningColumn")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {GRANT_PATHS.map((p) => (
                <TableRow key={p.badge}>
                  <TableCell>
                    <span
                      className={`inline-flex size-4 items-center justify-center rounded text-[9px] font-bold ${p.badgeClass}`}
                    >
                      {p.badge}
                    </span>
                  </TableCell>
                  <TableCell className="font-medium">{t(p.labelKey)}</TableCell>
                  <TableCell className="whitespace-normal text-muted-foreground">
                    {t(p.descriptionKey)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Max-wins rule */}
          <div className="flex flex-col gap-0.5 rounded-md border bg-background px-3 py-2">
            <p className="font-medium">{t("org.accessModelLegend.maxWinsHeading")}</p>
            <p className="text-muted-foreground">{t("org.accessModelLegend.maxWinsDescription")}</p>
          </div>
        </div>
      )}
    </div>
  )
}
