// Connect an org's Airtable with a personal access token (AQU-804). Airtable
// has no app-install flow like Monday's OAuth, so connecting is pasting a
// token: the server checks it with Airtable and stores it encrypted. Shown in
// Org settings → Airtable and in the setup wizard's connect step.

import { useState } from "react"
import { ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { RevealableInput } from "@/components/ui/revealable-input"
import { Spinner } from "@/components/ui/spinner"
import { connectAirtable, type AirtableConnectionStatus } from "@/lib/airtable/api"
import { useT } from "@/lib/i18n/I18nProvider"

/** Where a person makes a personal access token. */
const AIRTABLE_CREATE_TOKEN_URL = "https://airtable.com/create/tokens"

/** The scopes the token needs; schema.bases:write lets setup add missing fields. */
const AIRTABLE_TOKEN_SCOPES = [
  "data.records:read",
  "data.records:write",
  "schema.bases:read",
  "schema.bases:write",
] as const

export function AirtableTokenForm({
  jwt,
  orgId,
  onConnected,
  submitLabel,
}: {
  jwt: string | null
  orgId: number | null
  onConnected: (status: AirtableConnectionStatus) => void
  /** The button's words ("Connect Airtable" by default). */
  submitLabel?: string
}) {
  const t = useT()
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!jwt || orgId == null || !token.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const status = await connectAirtable(jwt, orgId, token.trim())
      setToken("")
      onConnected(status)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)} data-testid="airtable-token-form">
      <Field data-invalid={error != null}>
        <FieldLabel htmlFor="airtable-token">{t("settings.airtable.tokenLabel")}</FieldLabel>
        <RevealableInput
          id="airtable-token"
          revealKind="key"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          aria-invalid={error != null}
        />
        <FieldDescription>
          {t("settings.airtable.tokenHelp", { scopes: AIRTABLE_TOKEN_SCOPES.join(", ") })}{" "}
          <a
            href={AIRTABLE_CREATE_TOKEN_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-4"
          >
            {t("settings.airtable.createTokenLink")}
            <ExternalLink className="size-3" />
          </a>
        </FieldDescription>
        {error && <FieldError>{error}</FieldError>}
      </Field>
      <div>
        <Button type="submit" disabled={busy || !token.trim() || !jwt || orgId == null}>
          {busy && <Spinner data-icon="inline-start" />}
          {submitLabel ?? t("settings.airtable.connectButton")}
        </Button>
      </div>
    </form>
  )
}
