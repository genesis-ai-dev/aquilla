// Table / Document switch for a Bible book (AQU-2559). Shown in the file
// toolbar of both layouts, so the way back is where the way in was.

import { Rows3, ScrollText } from "lucide-react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"

export function EditorLayoutSwitch({ document, onChange }: { document: boolean; onChange: (document: boolean) => void }) {
  const t = useT()
  return (
    <Tabs value={document ? "document" : "table"} onValueChange={(value) => onChange(value === "document")} className="gap-0">
      <TabsList className="gap-0.5" aria-label={t("bibleDocument.view.switchLabel")} data-testid="editor-layout-switch">
        <AppTooltip content={t("bibleDocument.view.table")}>
          <TabsTrigger value="table" aria-label={t("bibleDocument.view.table")}>
            <Rows3 aria-hidden />
          </TabsTrigger>
        </AppTooltip>
        <AppTooltip content={t("bibleDocument.view.document")}>
          <TabsTrigger value="document" aria-label={t("bibleDocument.view.document")}>
            <ScrollText aria-hidden />
          </TabsTrigger>
        </AppTooltip>
      </TabsList>
    </Tabs>
  )
}
