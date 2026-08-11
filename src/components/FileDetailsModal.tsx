import { Pencil, FolderInput, Trash2, Download } from "lucide-react"
import type { FileReference } from "@/lib/parsers/types"
import { fileOrderedBy } from "@/lib/parsers/types"
import { ROLE } from "@/lib/frontier/roles"
import { canExportSourceFile, EXPORTABLE_SOURCE_FILE_TYPES } from "@/lib/file-source-export"
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
      <dd className="min-w-0 truncate text-right" title={typeof children === "string" ? children : undefined}>
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
  if (!file) return null

  const translatedPct = progress && progress.total > 0
    ? Math.round((progress.translated / progress.total) * 100) : null
  const validatedPct = progress && progress.total > 0
    ? Math.round((progress.validated / progress.total) * 100) : null

  const canExport = canExportSourceFile(file, canExportByOrgPolicy)
  const exportDisabledReason = canExport
    ? undefined
    : !EXPORTABLE_SOURCE_FILE_TYPES.has(file.type)
      ? "Only USFM files support round-trip source export."
      : "Source export is disabled by your organization's export policy."

  // AQU-271: delete requires project_lead (500) or above.
  const canDelete = roleLevel >= ROLE.PROJECT_LEAD
  const deleteDisabledReason = canDelete
    ? undefined
    : "Deleting files requires the Project Lead role or above."

  const languages = [file.sourceLanguage, file.targetLanguage].filter(Boolean).join(" → ")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{file.name}</DialogTitle>
          {file.originalName && file.originalName !== file.name && (
            <DialogDescription>Imported as {file.originalName}</DialogDescription>
          )}
        </DialogHeader>
        <DialogBody>
          <dl className="divide-y divide-border/50 text-[13px]">
            <DetailRow label="Type">{file.type.toUpperCase()}</DetailRow>
            {file.corpusMarker && <DetailRow label="Corpus">{file.corpusMarker}</DetailRow>}
            {file.bookCode && <DetailRow label="Book code">{file.bookCode}</DetailRow>}
            <DetailRow label="Segments">{String(file.cellCount)}</DetailRow>
            <DetailRow label="Ordering">
              {fileOrderedBy(file) === "time" ? "Timeline (timecodes)" : "Sequence"}
            </DetailRow>
            {languages && <DetailRow label="Languages">{languages}</DetailRow>}
            <DetailRow label="Imported">
              {new Date(file.createdAt).toLocaleDateString(undefined, {
                year: "numeric", month: "short", day: "numeric",
              })}
            </DetailRow>
            {translatedPct !== null && (
              <DetailRow label="Progress">{`${translatedPct}% translated · ${validatedPct}% validated`}</DetailRow>
            )}
          </dl>
          <div className="mt-4 flex flex-col gap-1.5">
            <ActionButton icon={<Pencil />} label="Rename" onClick={onRename} />
            <ActionButton icon={<FolderInput />} label="Move to corpus…" onClick={onMove} />
            <ActionButton
              icon={<Download />}
              label="Export source (.SFM)"
              onClick={onExportSource}
              disabledReason={exportDisabledReason}
            />
            <ActionButton
              icon={<Trash2 />}
              label="Delete"
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
