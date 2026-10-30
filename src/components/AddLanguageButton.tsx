// AQU-2263: the one "Add language" button, used wherever a language is added:
// New Project's target languages and Project settings → Languages. They read
// "Add another language" and "Add language" before; one piece keeps them the
// same.

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"

export function AddLanguageButton({
  onClick,
  disabled,
  testId,
}: {
  onClick: () => void
  disabled?: boolean
  testId?: string
}) {
  const t = useT()
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid={testId}
      data-add-language=""
      disabled={disabled}
      onClick={onClick}
    >
      <Plus className="size-4" aria-hidden="true" />
      {t("org.overviewLaneTable.addLanguageAction")}
    </Button>
  )
}
