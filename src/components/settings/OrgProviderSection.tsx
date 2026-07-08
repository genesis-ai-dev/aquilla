// FRO-433: Org-level provider API key management.
//
// Displayed inside the org Settings page. Editable only by org maintainer+.
// The key is stored in OrgWideSettings.orgProviderKeys and synced via the
// existing org-settings sync route — no new routes needed.
//
// Precedence at synthesis time:
//   project key > user (localStorage) key > org key (this section)

import { useState } from "react"
import { Check } from "lucide-react"
import { RevealableInput } from "@/components/ui/revealable-input"
import { Button } from "@/components/ui/button"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

interface OrgProviderSectionProps {
  orgSettings: UseOrgSettings
}

export function OrgProviderSection({ orgSettings }: OrgProviderSectionProps) {
  const { orgProviderKeys, canEditOrgKeys, patch, hasFetched } = orgSettings

  // Defensive: an org with no keys yet (or a partial hook contract) yields no map.
  const keys = orgProviderKeys ?? {}
  const currentGeminiKey = keys["gemini-tts"] ?? ""
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Use draft if the user is editing, otherwise show the stored value.
  const displayed = draft ?? currentGeminiKey

  async function handleSave() {
    const trimmed = displayed.trim()
    setBusy(true)
    setError(null)
    setSaved(false)
    const result = await patch({
      orgProviderKeys: {
        ...keys,
        "gemini-tts": trimmed || undefined,
      },
    })
    if (result.kind === "ok") {
      setDraft(null)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } else if (result.kind === "blocked" || result.kind === "forbidden") {
      setError("Only org maintainers and owners can set org-level API keys.")
    } else if (result.kind === "error") {
      setError(result.message ?? "Save failed")
    }
    setBusy(false)
  }

  function handleClear() {
    setDraft("")
  }

  if (!hasFetched) {
    return (
      <SettingsGroup label="Provider keys">
        <SettingsRow label="Gemini TTS API key" block>
          <p className="text-xs text-muted-foreground">Loading…</p>
        </SettingsRow>
      </SettingsGroup>
    )
  }

  return (
    <SettingsGroup label="Provider keys">
      {!canEditOrgKeys && (
        <div className="px-5 py-4 text-xs text-muted-foreground">
          Only org maintainers and owners can set org-level keys. You can still
          save a personal key in your project or personal settings.
        </div>
      )}
      <SettingsRow
        label="Gemini TTS API key"
        description="Used by Gemini TTS synthesis for all org members when no project or personal key is present. Precedence: project key > personal key > org key."
        block
      >
        <RevealableInput
          id="org-gemini-tts-key"
          revealKind="key"
          value={displayed}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={canEditOrgKeys ? "Paste Gemini API key…" : currentGeminiKey ? "(set by org admin)" : "(not set)"}
          disabled={!canEditOrgKeys || busy}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
        {canEditOrgKeys && (
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={handleSave}
              disabled={busy || draft === null}
            >
              {busy ? "Saving…" : "Save key"}
            </Button>
            {currentGeminiKey && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleClear}
                disabled={busy}
              >
                Clear
              </Button>
            )}
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        {saved && (
          <p className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400" role="status" data-testid="org-key-saved">
            <Check className="size-3.5" /> Saved
          </p>
        )}
      </SettingsRow>
    </SettingsGroup>
  )
}
