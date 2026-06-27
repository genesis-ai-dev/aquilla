// FRO-433: Org-level provider API key management.
//
// Displayed inside the org Settings page. Editable only by org maintainer+.
// The key is stored in OrgWideSettings.orgProviderKeys and synced via the
// existing org-settings sync route — no new routes needed.
//
// Precedence at synthesis time:
//   project key > user (localStorage) key > org key (this section)

import { useState } from "react"
import { Check, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Section } from "@/components/ui/page"
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
  const [show, setShow] = useState(false)
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
      <Section title="Provider API keys">
        <p className="text-xs text-muted-foreground">Loading…</p>
      </Section>
    )
  }

  return (
    <Section
      title="Provider API keys"
      description={
        <>
          Org-level keys act as a baseline for everyone in this org. Projects or
          individuals can override with their own. Precedence: project key &gt;
          personal key &gt; org key.
        </>
      }
    >
      {!canEditOrgKeys && (
        <p className="mb-4 text-xs text-muted-foreground">
          Only org maintainers and owners can set org-level keys. You can still
          save a personal key in your project or personal settings.
        </p>
      )}

      <div className="space-y-4">
        {/* Gemini TTS */}
        <div className="space-y-2">
          <Label htmlFor="org-gemini-tts-key" className="text-sm font-medium">
            Gemini TTS API key
          </Label>
          <div className="flex gap-2">
            <Input
              id="org-gemini-tts-key"
              type={show ? "text" : "password"}
              value={displayed}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={canEditOrgKeys ? "Paste Gemini API key…" : currentGeminiKey ? "(set by org admin)" : "(not set)"}
              disabled={!canEditOrgKeys || busy}
              autoComplete="off"
              spellCheck={false}
              className="flex-1 font-mono"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? "Hide key" : "Show key"}
              disabled={!canEditOrgKeys}
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Used by Gemini TTS synthesis for all org members when no project or
            personal key is present.
          </p>
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
        </div>
      </div>
    </Section>
  )
}
