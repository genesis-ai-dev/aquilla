/**
 * AQU-270: 404 catch-all page (audit finding F-IA3).
 *
 * Rendered by the `*` catch-all route in App.tsx so bad links never blank-screen.
 * Styled to match the ErrorBoundary empty-state pattern (centred icon + title +
 * description + action button). Uses min-h-screen + document scroll per the
 * scroll-model rule.
 */

import { Link } from "react-router-dom"
import { FileQuestion } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"

export function NotFound() {
  const t = useT()
  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <div className="text-muted-foreground">
          <FileQuestion className="h-10 w-10" aria-hidden />
        </div>
        <h1 className="text-base font-medium">{t("error.notFound.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("error.notFound.description")}
        </p>
        <div className="mt-2">
          <Link to="/">
            <Button size="sm" variant="outline">
              {t("error.notFound.goHome")}
            </Button>
          </Link>
        </div>
      </div>
    </div>
  )
}
