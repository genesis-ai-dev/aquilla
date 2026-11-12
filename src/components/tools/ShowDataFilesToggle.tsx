import { Switch } from "@/components/ui/switch"
import { useT } from "@/lib/i18n/I18nProvider"
import { setShowExtensionDataFiles, useShowExtensionDataFiles } from "@/lib/tools/show-data-files"

/** apiRev 7: let the user see the hidden extension data files in the file list. */
export function ShowDataFilesToggle() {
  const t = useT()
  const on = useShowExtensionDataFiles()
  return (
    <label className="flex items-start gap-3 rounded-xl border px-3 py-2.5 text-sm" data-testid="show-data-files">
      <Switch checked={on} onCheckedChange={(checked) => setShowExtensionDataFiles(checked)} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block font-medium">{t("extensions.dataFiles.show")}</span>
        <span className="block text-xs text-muted-foreground">{t("extensions.dataFiles.hint")}</span>
      </span>
    </label>
  )
}
