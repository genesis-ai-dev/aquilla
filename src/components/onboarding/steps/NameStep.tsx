import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { ChevronLeft } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"

export function NameStep({
  value,
  onChange,
  onSave,
  onNext,
  onBack,
}: {
  value: string
  onChange: (v: string) => void
  /** AQU-2259: called with the trimmed name on Continue, to save it as the
   *  account's display name. Not called when the field is empty. */
  onSave?: (name: string) => void
  onNext: () => void
  onBack: () => void
}) {
  const t = useT()
  const { session } = useFrontierSession()

  // Pre-fill from Frontier session if user hasn't typed anything yet
  useEffect(() => {
    if (session?.username && !value) {
      onChange(session.username)
    }
  }, [session?.username])

  // AQU-2259: the name used to go to a browser key nothing read. It is the
  // account's display name now; an empty field leaves the username in place.
  function handleContinue() {
    const name = value.trim()
    onChange(name)
    if (name) onSave?.(name)
    onNext()
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-semibold">{t("onboarding.step.name.heading")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("onboarding.step.name.description")}
        </p>
      </div>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="display-name">{t("onboarding.step.name.displayNameLabel")}</FieldLabel>
          <Input
            id="display-name"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t("onboarding.step.name.displayNamePlaceholder")}
            autoFocus
          />
        </Field>
      </FieldGroup>
      <Button size="lg" onClick={handleContinue} className="w-full">
        {t("onboarding.common.continue")}
      </Button>
      <Button variant="ghost" size="sm" onClick={onBack} className="w-full">
        <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
        {t("common.back")}
      </Button>
    </div>
  )
}
