// FRO-433: Org-level provider API key management.
//
// Displayed inside the org Settings page. Editable only by org maintainer+.
// The key is stored in OrgWideSettings.orgProviderKeys and synced via the
// existing org-settings sync route — no new routes needed.
//
// Precedence at synthesis time:
//   project key > user (localStorage) key > org key (this section)

import { useState } from "react"
import { Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

interface OrgProviderSectionProps {
  orgSettings: UseOrgSettings
}

export function OrgProviderSection({ orgSettings }: OrgProviderSectionProps) {
  const { orgProviderKeys, canEditOrgKeys, patch, hasFetched } = orgSettings

  const currentGeminiKey = orgProviderKeys["gemini-tts"] ?? ""
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
        ...orgProviderKeys,
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
      <section className="rounded-lg border bg-card p-4">
        <h2 className="text-base font-semibold">Provider API keys</h2>
        <p className="mt-1 text-xs text-muted-foreground">Loading…</p>
      </section>
    )
  }

  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="text-base font-semibold">Provider API keys</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Org-level API keys act as a baseline for all members and projects in
        this org. Individual projects or users can override with their own key.
        Precedence: project key &gt; personal key &gt; org key.
      </p>

      {!canEditOrgKeys && (
        <p className="mt-2 text-xs text-muted-foreground">
          Only org maintainers and owners can set org-level keys. You can still
          save a personal key in your project or personal settings.
        </p>
      )}

      <div className="mt-4 space-y-4">
        {/* Gemini TTS */}
        <div className="space-y-2">
          <Label htmlFor="org-gemini-tts-key" className="text-xs">
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
                {busy ? "Saving…" : "Save"}
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
            <p className="text-xs text-green-600 dark:text-green-400" role="status" data-testid="org-key-saved">
              Saved
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
