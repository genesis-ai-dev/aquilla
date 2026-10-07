// The Data sources dialog of the Bible data card (AQU-1686): credits each
// open dataset behind Bible data, with its license. Attribution is a license
// condition for every one of them (CC BY and CC BY-SA), not a courtesy.

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useT } from "@/lib/i18n/I18nProvider"
import { BIBLE_DATA_SOURCE_NAME_KEYS } from "@/lib/bible-data/enrichment-labels"
import {
  BIBLE_DATA_LICENSE_URLS,
  BIBLE_DATA_SOURCE_IDS,
  BIBLE_DATA_SOURCE_LICENSES,
} from "../../../db/shared/bible-enrichments"

export function BibleDataSourcesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("bibleData.sources.title")}</DialogTitle>
          <DialogDescription>{t("bibleData.sources.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ul className="divide-y rounded-md border">
            {BIBLE_DATA_SOURCE_IDS.map((id) => {
              const license = BIBLE_DATA_SOURCE_LICENSES[id]
              return (
                <li
                  key={id}
                  data-testid={`bible-data-source-${id}`}
                  className="flex items-center justify-between gap-4 px-3 py-2"
                >
                  <span className="min-w-0 text-sm">{t(BIBLE_DATA_SOURCE_NAME_KEYS[id])}</span>
                  <a
                    href={BIBLE_DATA_LICENSE_URLS[license]}
                    target="_blank"
                    rel="noopener noreferrer"
                    dir="ltr"
                    className="shrink-0 text-xs text-muted-foreground underline underline-offset-3 hover:text-foreground"
                  >
                    {license}
                  </a>
                </li>
              )
            })}
          </ul>
        </DialogBody>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}
