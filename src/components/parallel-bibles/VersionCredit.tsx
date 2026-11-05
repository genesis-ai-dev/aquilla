// The short credit under each version: its name, then a link to its licence
// and to its own site when the catalogue gives one (SBLGNT's CC BY 4.0 terms
// ask for a link to sblgnt.com). Both open in a new tab.

import { useT } from "@/lib/i18n/I18nProvider"
import type { HelloaoTranslation } from "@/lib/parsers/helloao"
import { versionCredit } from "@/lib/parallel-bibles/version-display"
import { cn } from "@/lib/utils"

const LINK = "underline decoration-dotted underline-offset-2 hover:text-foreground"

export function VersionCredit({
  versionId,
  meta,
  className,
}: {
  versionId: string
  meta: HelloaoTranslation | undefined
  className?: string
}) {
  const t = useT()
  const credit = versionCredit(versionId, meta)
  return (
    <p data-testid="version-credit" className={cn("text-[10px] text-muted-foreground/70", className)}>
      <span>{credit.name}</span>
      {credit.licenseUrl && (
        <>
          {" · "}
          <a href={credit.licenseUrl} target="_blank" rel="noopener noreferrer" className={LINK}>
            {t("editor.bibles.creditLicense")}
          </a>
        </>
      )}
      {credit.websiteUrl && (
        <>
          {" · "}
          <a href={credit.websiteUrl} target="_blank" rel="noopener noreferrer" className={LINK}>
            {t("editor.bibles.creditWebsite")}
          </a>
        </>
      )}
    </p>
  )
}
