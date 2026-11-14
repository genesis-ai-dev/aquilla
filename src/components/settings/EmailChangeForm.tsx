import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { removeSessionByJwt } from "@/lib/frontier/session-store"
import { Button } from "@/components/ui/button"
import { REGEXP_ONLY_DIGITS } from "input-otp"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Input } from "@/components/ui/input"
import { RevealableInput } from "@/components/ui/revealable-input"
import { Field, FieldLabel } from "@/components/ui/field"
import { AUTH_BASE } from "@/lib/frontier/auth"
import { clearGoogleAttempt } from "@/lib/frontier/google-login"

const messages: Record<string, MessageKey> = {
  password_required: "auth.emailChange.password_required",
  incorrect_password: "auth.emailChange.incorrect_password",
  admin_verification_required: "auth.emailChange.admin_verification_required",
  administrator_coordination_required:
    "auth.emailChange.administrator_coordination_required",
  destination_dev_access_required:
    "auth.emailChange.destination_dev_access_required",
  email_unavailable: "auth.emailChange.email_unavailable",
  email_unchanged: "auth.emailChange.email_unchanged",
  ownership_proof_required: "auth.emailChange.ownership_proof_required",
  email_delivery_unavailable: "auth.emailChange.email_delivery_unavailable",
  invalid_or_expired_code: "auth.emailChange.invalid_or_expired_code",
  rate_limited: "auth.emailChange.rate_limited",
  restart: "auth.emailChange.accountChanged",
}
export function EmailChangeForm({
  jwt,
  passwordAvailable,
  googleLinked = false,
  onBack,
  onSetPassword,
  statusUnavailable = false,
}: {
  jwt: string
  passwordAvailable: boolean
  googleLinked?: boolean
  statusUnavailable?: boolean
  onSetPassword: () => void
  onBack: () => void
}) {
  const t = useT()
  const navigate = useNavigate()
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [token, setToken] = useState("")
  const [sent, setSent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  async function submit() {
    if (!passwordAvailable || busy || (sent && !/^[0-9]{6}$/.test(token))) return
    setBusy(true)
    setError("")
    try {
      const response = await fetch(
        `${AUTH_BASE}/api/v2/auth/email-change/${sent ? "confirm" : "request"}`,
        {
          method: "POST",
          credentials: "omit",
          cache: "no-store",
          signal: AbortSignal.timeout(20_000),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify(
            sent
              ? { token }
              : {
                  email,
                  password,
                },
          ),
        },
      )
      const body = await response.json()
      if (!response.ok)
        throw new Error(
          typeof body.error === "string" ? body.error : "unavailable",
        )
      if (sent) {
        clearGoogleAttempt()
        await removeSessionByJwt(jwt)
        navigate("/login?add=1", { replace: true, state: { emailChanged: email } })
      } else setSent(true)
    } catch (reason) {
      setError(
        t(
          messages[reason instanceof Error ? reason.message : ""] ??
            "auth.emailChange.failed",
        ),
      )
    } finally {
      setBusy(false)
      setPassword("")
    }
  }
  if (!passwordAvailable) return <div className="flex flex-col gap-4">
    <p role="status">{t("auth.emailChange.password_required")}</p>
    <Button type="button" variant="outline" disabled={statusUnavailable} onClick={onSetPassword}>{t("auth.methods.setPassword")}</Button>
  </div>
  return (
    <form
      className="flex max-w-md flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <p className="text-sm text-muted-foreground">
        {t("auth.emailChange.intro")}
      </p>
      {googleLinked && <p className="text-sm" role="note">{t("auth.emailChange.unlinkWarning")}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {sent ? (
        <>
          <p role="status">
            {t("auth.emailChange.sent")} {email}. {t("auth.emailChange.expiry")}
          </p>
          <Field>
            <FieldLabel htmlFor="email-change-code">
              {t("auth.emailChange.code")}
            </FieldLabel>
            <InputOTP
              maxLength={6}
              pattern={REGEXP_ONLY_DIGITS}
              inputMode="numeric"
              id="email-change-code"
              autoComplete="one-time-code"
              required
              value={token}
              onChange={setToken}
            >
              <InputOTPGroup>
                {Array.from({ length: 6 }, (_, index) => <InputOTPSlot key={index} index={index} />)}
              </InputOTPGroup>
            </InputOTP>
          </Field>
        </>
      ) : (
        <>
          <Field>
            <FieldLabel htmlFor="email-change-address">
              {t("auth.emailChange.address")}
            </FieldLabel>
            <Input
              id="email-change-address"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          {passwordAvailable && (
            <Field>
              <FieldLabel htmlFor="email-change-password">
                {t("auth.emailChange.password")}
              </FieldLabel>
              <RevealableInput
                id="email-change-password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          )}
        </>
      )}
      {(sent || passwordAvailable) && (
        <Button disabled={busy || (sent && token.length !== 6)} type="submit">
          {t(sent ? "auth.emailChange.confirm" : "auth.emailChange.send")}
        </Button>
      )}
      {sent && (
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setSent(false)
            setToken("")
            setError("")
          }}
        >
          {t("auth.emailChange.restart")}
        </Button>
      )}
      <Button type="button" variant="ghost" disabled={busy} onClick={onBack}>
        {t("auth.emailChange.back")}
      </Button>
    </form>
  )
}
