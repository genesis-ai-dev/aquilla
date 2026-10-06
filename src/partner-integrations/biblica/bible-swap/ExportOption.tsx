// Export-dialog wrapper for Bible Swap. Owns the settings and turns them into
// the transform the generic exporter runs after the notes-only IDML is built.
// The swap engine and the mapping JSON stay behind dynamic imports so they
// load only when this panel does.

import { useCallback, useEffect, useState } from "react"
import { useT } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
import type { PartnerIdmlExportPanelProps } from "@/lib/partners/types"
import { BibleSwapPanel } from "./BibleSwapPanel"
import {
  DEFAULT_BIBLE_SWAP_SETTINGS,
  type BibleSwapSettings,
} from "./settings"

export default function BibleSwapExportOption({
  disabled = false,
  fileName,
  loadSourcePackage,
  onTransformChange,
}: PartnerIdmlExportPanelProps) {
  const t = useT()
  const [settings, setSettings] = useState<BibleSwapSettings>(DEFAULT_BIBLE_SWAP_SETTINGS)

  const analyze = useCallback(async (bibleFile: File) => {
    if (!loadSourcePackage || !fileName) {
      throw new Error("The original Biblica package is not available to score.")
    }
    const studyBytes = await loadSourcePackage()
    const bibleBytes = new Uint8Array(await bibleFile.arrayBuffer())
    const { analyzeBibleSwapCompatibility } = await import("./compatibility")
    return analyzeBibleSwapCompatibility(bibleFile.name, bibleBytes, [{
      fileName,
      idmlData: studyBytes,
    }])
  }, [fileName, loadSourcePackage])

  useEffect(() => {
    if (settings.mode === "none" || !settings.bibleFile) {
      onTransformChange(null)
      return
    }

    const bibleFile = settings.bibleFile
    const language = settings.language
    const swapMode = settings.mode
    const studyFileName = fileName ?? "study.idml"
    onTransformChange({
      busyMessage: t("importExport.bibleSwap.status.swapping"),
      failureMessage: (reason) => t("importExport.bibleSwap.status.failed", { reason }),
      apply: async (idml) => {
        const [
          { applyBibleSwapToIdml },
          { createBibleSwapRunner },
          { loadBibleSwapMappingPlan },
        ] = await Promise.all([
          import("./swap-runner"),
          import("./swap-worker-client"),
          import("./mapping-loader"),
        ])
        const mapping = await loadBibleSwapMappingPlan(language, studyFileName)
        const bibleBytes = new Uint8Array(await bibleFile.arrayBuffer())
        const swapped = await applyBibleSwapToIdml(idml, bibleBytes, {
          swapMode,
          parallelRunner: createBibleSwapRunner(),
          language,
          ...(mapping ? { serializedPlan: mapping.plan, studyVolume: mapping.volume } : {}),
        })
        const downloaded = studyFileName.replace(/\.[^.]+$/, "") + ".idml"
        return {
          bytes: swapped.idml,
          statusMessage: t("importExport.bibleSwap.status.done", {
            fileName: downloaded,
            count: formatNumber(swapped.report.replacedVerses),
            stories: formatNumber(swapped.report.modifiedStories),
          }),
        }
      },
    })

    return () => onTransformChange(null)
  }, [fileName, onTransformChange, settings.bibleFile, settings.language, settings.mode, t])

  return (
    <div className="rounded-xl border border-border/60 bg-accent/30 px-3 py-3">
      <BibleSwapPanel
        settings={settings}
        onChange={setSettings}
        onAnalyze={analyze}
        disabled={disabled}
      />
    </div>
  )
}
