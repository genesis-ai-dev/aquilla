// The document preview panel: a Word or PowerPoint file laid out as the
// document it is, or an InDesign file as its text in reading order, with the
// translation typed so far in place of the source, beside the editor's table. It is the file an export writes now, built in the
// browser from the stored original (useDocumentPreview) and drawn by a
// rendering library (lib/document-preview/renderers.ts).

import { useState } from "react"
import { FileSearch, X } from "lucide-react"
import { RightSidebarPanel } from "@/components/RightSidebarPanel"
import { Button } from "@/components/ui/button"
import type { CellData } from "@/hooks/useCells"
import type { DocumentPreviewKind } from "@/lib/document-preview/build"
import { useT } from "@/lib/i18n/I18nProvider"
import { DocumentPreviewFrame } from "./DocumentPreviewFrame"
import { useDocumentPreview } from "./useDocumentPreview"

export interface DocumentPreviewSidebarProps {
  kind: DocumentPreviewKind
  projectId: string
  fileId: string
  lane?: string
  targetLanguage?: string | null
  cells: CellData[]
  /** True until the store holds the whole file. */
  cellsLoading: boolean
  getToken: (fileId: string) => Promise<string | null>
  onClose: () => void
}

export function DocumentPreviewSidebar(props: DocumentPreviewSidebarProps) {
  const { kind, onClose } = props
  const t = useT()
  const state = useDocumentPreview(props)
  const [renderFailed, setRenderFailed] = useState(false)

  const waiting = state.status === "loading"
  const message =
    state.status === "forbidden" ? t("documentPreview.forbidden")
      : state.status === "missing" ? t("documentPreview.missing")
        : state.status === "error" ? t("documentPreview.error")
          : renderFailed ? t("documentPreview.renderError")
            : waiting ? t("common.loading")
              : null

  return (
    <RightSidebarPanel
      storageKey="document-preview"
      defaultWidth={520}
      minWidth={320}
      maxWidth={1100}
      className="hidden sm:flex"
      resizeLabel={t("documentPreview.resize")}
    >
      <section aria-label={t("common.preview")} className="flex h-full w-full flex-col border-l bg-card text-sm" data-testid="document-preview-panel">
        <div className="flex items-center justify-between border-b p-2">
          <div className="flex min-w-0 items-center gap-1.5 font-medium">
            <FileSearch className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>{t("common.preview")}</span>
            {state.status === "ready" && state.updating ? (
              <span role="status" className="truncate text-xs font-normal text-muted-foreground">{t("documentPreview.updating")}</span>
            ) : null}
          </div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("documentPreview.hide")} onClick={onClose} className="text-muted-foreground">
            <X />
          </Button>
        </div>
        <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
          {t(kind === "docx" ? "documentPreview.hint.docx" : kind === "pptx" ? "documentPreview.hint.pptx" : "documentPreview.hint.idml")}
        </p>
        {state.status === "ready" && state.behind && !state.updating ? (
          <p role="status" className="border-b bg-muted/40 px-3 py-1.5 text-xs text-foreground" data-testid="document-preview-behind">
            {t("documentPreview.behind")}
          </p>
        ) : null}
        {message ? (
          <p role="status" aria-busy={waiting} className="p-4 text-sm text-muted-foreground">{message}</p>
        ) : null}
        {state.status === "ready" ? (
          <div className={renderFailed ? "hidden" : "min-h-0 flex-1"}>
            <DocumentPreviewFrame
              kind={kind}
              bytes={state.bytes}
              title={t("documentPreview.frameTitle")}
              onRenderError={setRenderFailed}
            />
          </div>
        ) : null}
      </section>
    </RightSidebarPanel>
  )
}
