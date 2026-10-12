/**
 * AQU-525: JSON source import with an explicit key selection.
 *
 * The general uploader hands a single `.json`/`.arb` file here instead of
 * flattening every string leaf into a cell. This panel lists the document's
 * string leaves (JsonKeyPickerPanel), then imports only the selected paths and
 * retains the original bytes as the file's source side-car so the translated
 * document can be written back into its original shape on export
 * (ExportDialog → `exportJson({ keyed: true })`).
 *
 * After the selection, cells go through the standard preview → confirm →
 * upload pipeline, exactly as SpreadsheetImportPanel does after column mapping.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import type { FileReference } from "@/lib/parsers/types"
import { extractJsonStrings, listJsonStringPaths, type JsonStringLeaf } from "@/lib/parsers/json-i18n"
import { importFile, type ImportResult, type ImportContext } from "@/lib/import"
import type { PreparedImportFile } from "@/lib/import/import-service"
import { decodeImportText } from "@/lib/import/ai-recipe"
import { assertSourceUploadByteLength } from "@/lib/sync/source-upload"
import { JsonKeyPickerPanel } from "./JsonKeyPickerPanel"

export interface JsonImportPanelProps {
  projectId: string
  username: string
  sourceLanguage: string
  targetLanguage: string
  /** Active target-language lane. Empty/undefined is the default lane. */
  targetLang?: string
  getToken: (fileId: string) => Promise<string | null>
  onPreview?: (results: ImportResult[], commit: () => Promise<void>) => void
  /** Surface failures after this panel unmounts for the preview. */
  onCommitError?: (message: string | null) => void
  onImported: (refs: FileReference[]) => void | Promise<void>
  onCancel: () => void
  /** File handed off from the general dropzone; parsed exactly once on mount. */
  initialFile?: File | null
}

type Step = "reading" | "keys" | "uploading"

export function JsonImportPanel({
  projectId,
  username,
  sourceLanguage,
  targetLanguage,
  targetLang,
  getToken,
  onPreview,
  onCommitError,
  onImported,
  onCancel,
  initialFile,
}: JsonImportPanelProps) {
  const t = useT()
  const [step, setStep] = useState<Step>("reading")
  const [error, setError] = useState<string | null>(null)
  const [leaves, setLeaves] = useState<readonly JsonStringLeaf[]>([])
  // Rendered, so it is state — the File itself stays in a ref (commit-time data).
  const [fileName, setFileName] = useState("")
  const sourceText = useRef<string>("")
  const sourceBytes = useRef<ArrayBuffer | null>(null)
  const sourceFile = useRef<File | null>(null)
  const consumedInitialFile = useRef<File | null>(null)
  // Survives a failed upload so a retry re-sends rather than re-importing.
  const importedRefs = useRef<FileReference[] | null>(null)

  const handleFile = useCallback(async (file: File) => {
    setError(null)
    importedRefs.current = null
    sourceFile.current = file
    setFileName(file.name)
    try {
      assertSourceUploadByteLength(file.size)
      const bytes = await file.arrayBuffer()
      const text = decodeImportText(bytes, file.name)
      const found = listJsonStringPaths(text)
      if (found.length === 0) {
        setError(t("importExport.jsonKeys.noStrings", { fileName: file.name }))
        return
      }
      sourceBytes.current = bytes
      sourceText.current = text
      setLeaves(found)
      setStep("keys")
    } catch (err) {
      setError(err instanceof Error ? err.message : t("importExport.errors.failedToParseFile"))
    }
  }, [t])

  useEffect(() => {
    if (!initialFile || consumedInitialFile.current === initialFile) return
    consumedInitialFile.current = initialFile
    void handleFile(initialFile)
  }, [handleFile, initialFile])

  const doCommit = useCallback(async (importResult: ImportResult) => {
    const file = sourceFile.current
    if (!file) return
    setStep("uploading")
    onCommitError?.(null)
    try {
      const ctx: ImportContext = {
        projectId,
        author: username,
        sourceLanguage,
        targetLanguage,
        targetLang,
        getToken,
      }
      const prepared: PreparedImportFile = { fileType: "json", results: [importResult] }
      if (!importedRefs.current) {
        const imported = await importFile(file, ctx, prepared)
        importedRefs.current = imported.refs
      }
      await onImported(importedRefs.current)
    } catch (err) {
      const message = err instanceof Error ? err.message : t("common.uploadFailed")
      setError(message)
      onCommitError?.(message)
      setStep("keys")
    }
  }, [getToken, onCommitError, onImported, projectId, sourceLanguage, targetLanguage, targetLang, username, t])

  const handleConfirm = useCallback((includePaths: string[]) => {
    const file = sourceFile.current
    const bytes = sourceBytes.current
    if (!file || !bytes) return
    setError(null)
    const importResult: ImportResult = {
      name: file.name,
      strings: extractJsonStrings(sourceText.current, { include: includePaths }),
      rawBytes: bytes,
      // Registered source-artifact format: the original document is kept in R2
      // so export can substitute translations into it by key.
      rawSourceFormat: "json",
    }
    if (onPreview) {
      onPreview([importResult], () => doCommit(importResult))
      return
    }
    void doCommit(importResult)
  }, [doCommit, onPreview])

  if (step === "keys" && leaves.length > 0) {
    return (
      <div className="flex flex-col gap-2">
        <JsonKeyPickerPanel
          fileName={fileName}
          leaves={leaves}
          onConfirm={handleConfirm}
          onCancel={onCancel}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    )
  }

  if (step === "uploading") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-8">
        <p className="text-sm font-medium">{t("common.uploading")}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 py-8">
      {error
        ? <p className="text-xs text-destructive">{error}</p>
        : <p className="text-center text-sm text-muted-foreground">{t("importExport.jsonKeys.reading")}</p>}
      <div className="flex justify-end">
        <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
      </div>
    </div>
  )
}
