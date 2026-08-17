// Reusable API key input with a "Save across my projects" toggle.
//
// The toggle mirrors writes to localStorage (via user-api-keys), so the
// same key works in any other project on this browser. The project-level
// value always wins at read time. When the project field is empty but a
// user-saved key exists, the field shows it (masked) and the "Using your
// saved key" hint appears.

import { useEffect, useState, type ReactNode } from "react"
import { RevealableInput } from "@/components/ui/revealable-input"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { useT } from "@/lib/i18n/I18nProvider"

interface ApiKeyFieldProps {
  label: ReactNode
  placeholder?: string
  projectKey: string
  userKey: string
  onProjectKeyChange: (next: string) => void
  onUserKeyChange: (next: string) => void
  help?: string
}

export function ApiKeyField({
  label, placeholder, projectKey, userKey,
  onProjectKeyChange, onUserKeyChange, help,
}: ApiKeyFieldProps) {
  const t = useT()
  const [draft, setDraft] = useState(projectKey || userKey)
  // Default the toggle ON unless this project already carries its own key.
  // A BYOK key is set once and kept; the localStorage path (onUserKeyChange)
  // reliably survives reloads, whereas the project-record path can be clobbered
  // when the server-sourced project record is re-cached. So persist to
  // localStorage by default — otherwise a first-time key is lost on reload.
  const [saveAcrossProjects, setSaveAcrossProjects] = useState(
    () => projectKey.trim().length === 0,
  )

  useEffect(() => {
    setDraft(projectKey || userKey)
  }, [projectKey, userKey])

  const usingSavedKey = !projectKey && Boolean(userKey)

  const persist = (value: string) => {
    const trimmed = value.trim()
    onProjectKeyChange(trimmed)
    if (saveAcrossProjects) onUserKeyChange(trimmed)
  }

  const clearSavedKey = () => {
    onUserKeyChange("")
    setSaveAcrossProjects(false)
  }

  return (
    <Field className="space-y-2">
      {label && <FieldLabel>{label}</FieldLabel>}
      <RevealableInput
        revealKind="key"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => persist(draft)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
      />

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={saveAcrossProjects}
          onCheckedChange={(checked) => {
            const next = checked
            setSaveAcrossProjects(next)
            onUserKeyChange(next ? draft.trim() : "")
          }}
        />
        {t("workspace.apiKeyField.saveAcrossProjects")}
      </label>

      {usingSavedKey && (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">
          {t("workspace.apiKeyField.usingSavedKey")}
        </p>
      )}
      {userKey && (
        <button
          type="button"
          onClick={clearSavedKey}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {t("workspace.apiKeyField.forgetSavedKey")}
        </button>
      )}
      {help && <FieldDescription>{help}</FieldDescription>}
    </Field>
  )
}
