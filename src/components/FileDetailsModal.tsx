import { Pencil, FolderInput, Trash2, Download } from "lucide-react"
import type { FileReference } from "@/lib/parsers/types"
import { fileOrderedBy } from "@/lib/parsers/types"
import { ROLE } from "@/lib/frontier/roles"
import { canExportSourceFile, EXPORTABLE_SOURCE_FILE_TYPES } from "@/lib/file-source-export"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { bidiIsolate, formatDate, formatNumber } from "@/lib/i18n/format"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface FileStats { translated: number; validated: number; total: number }

interface FileDetailsModalProps {
  file: FileReference | null
  open: boolean
  onOpenChange: (open: boolean) => void
  progress?: FileStats
  /** Caller's project role level (`project.syncRole.level`, 0 when unknown). */
  roleLevel: number
  /** AQU-253: org export policy — when false, source export is disabled with a reason. */
  canExportByOrgPolicy: boolean
  onRename: () => void
  onMove: () => void
  onExportSource: () => void
  onDelete: () => void
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-end" title={typeof children === "string" ? children : undefined}>
        {children}
      </dd>
    </div>
  )
}

/** An action button that stays visible when disallowed, with the reason on hover. */
function ActionButton({
  icon, label, onClick, disabledReason, destructive,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  /** When set, the button renders disabled and this text explains why. */
  disabledReason?: string
  destructive?: boolean
}) {
  const button = (
    <Button
      variant={destructive ? "destructive" : "outline"}
      size="sm"
      className="justify-start gap-2"
      disabled={disabledReason !== undefined}
      onClick={onClick}
    >
      {icon} {label}
    </Button>
  )
  if (!disabledReason) return button
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {button}
      <span className="text-[11px] text-muted-foreground">{disabledReason}</span>
    </div>
  )
}

/**
 * "File details" modal opened from a sidebar file row's ⋯ menu. Shows the
 * file's metadata plus the row actions — actions the caller lacks permission
 * for stay visible but clearly disabled with the reason.
 */
export function FileDetailsModal({
  file, open, onOpenChange, progress, roleLevel, canExportByOrgPolicy,
  onRename, onMove, onExportSource, onDelete,
}: FileDetailsModalProps) {
  const { t, locale } = useI18n()
  if (!file) return null

  const translatedPct = progress && progress.total > 0
    ? Math.round((progress.translated / progress.total) * 100) : null
  const validatedPct = progress && progress.total > 0
    ? Math.round((progress.validated / progress.total) * 100) : null

  const canExport = canExportSourceFile(file, canExportByOrgPolicy)
  const exportDisabledReason = canExport
    ? undefined
    : !EXPORTABLE_SOURCE_FILE_TYPES.has(file.type)
      ? t("fileDetails.exportDisabledType")
      : t("fileDetails.exportDisabledPolicy")

  // AQU-271: delete requires project_lead (500) or above.
  const canDelete = roleLevel >= ROLE.PROJECT_LEAD
  const deleteDisabledReason = canDelete
    ? undefined
    : t("fileDetails.deleteRequiresRole")

  // AQU-i18n: arrow glyph is wrapped so it visually mirrors under RTL instead
  // of pointing away from the target language.
  const languages =
    file.sourceLanguage && file.targetLanguage ? (
      <>
        {file.sourceLanguage} <span className="inline-block rtl:-scale-x-100">→</span> {file.targetLanguage}
      </>
    ) : (
      file.sourceLanguage || file.targetLanguage || null
    )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate pe-8">{file.name}</DialogTitle>
          {file.originalName && file.originalName !== file.name && (
            <DialogDescription>{t("fileDetails.importedAs", { name: file.originalName })}</DialogDescription>
          )}
        </DialogHeader>
        <DialogBody>
          <dl className="divide-y divide-border/50 text-[13px]">
            <DetailRow label={t("fileDetails.type")}>{file.type.toUpperCase()}</DetailRow>
            {file.corpusMarker && <DetailRow label={t("fileDetails.corpus")}>{file.corpusMarker}</DetailRow>}
            {file.bookCode && <DetailRow label={t("fileDetails.bookCode")}>{file.bookCode}</DetailRow>}
            <DetailRow label={t("fileDetails.segments")}>{String(file.cellCount)}</DetailRow>
            <DetailRow label={t("fileDetails.ordering")}>
              {fileOrderedBy(file) === "time"
                ? t("fileDetails.orderingTimeline")
                : t("fileDetails.orderingSequence")}
            </DetailRow>
            {languages && <DetailRow label={t("fileDetails.languages")}>{languages}</DetailRow>}
            <DetailRow label={t("fileDetails.imported")}>
              {formatDate(file.createdAt, locale, { year: "numeric", month: "short", day: "numeric" })}
            </DetailRow>
            {translatedPct !== null && validatedPct !== null && (
              <DetailRow label={t("fileDetails.progress")}>
                {t("fileDetails.progressValue", {
                  translated: bidiIsolate(formatNumber(translatedPct, locale)),
                  validated: bidiIsolate(formatNumber(validatedPct, locale)),
                })}
              </DetailRow>
            )}
          </dl>
          <div className="mt-4 flex flex-col gap-1.5">
            <ActionButton icon={<Pencil />} label={t("fileDetails.rename")} onClick={onRename} />
            <ActionButton icon={<FolderInput />} label={t("fileDetails.moveToCorpus")} onClick={onMove} />
            <ActionButton
              icon={<Download />}
              label={t("fileDetails.exportSource")}
              onClick={onExportSource}
              disabledReason={exportDisabledReason}
            />
            <ActionButton
              icon={<Trash2 />}
              label={t("common.delete")}
              onClick={onDelete}
              disabledReason={deleteDisabledReason}
              destructive
            />
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
