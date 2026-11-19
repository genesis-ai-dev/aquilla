import { notifySessionExpiredIfCurrent } from "@/lib/frontier/session-expiry"
import { useT } from "@/lib/i18n/I18nProvider"
import { useEffect, useState, useId, type ReactNode } from "react"
import QRCode from "qrcode"
import { AUTH_BASE, finalizeSession } from "@/lib/frontier/auth"
import { useAccounts } from "@/hooks/useAccounts"
import { startGoogleLogin } from "@/lib/frontier/google-login"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
} from "@/components/ui/dialog"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { Button } from "@/components/ui/button"
import { RevealableInput } from "@/components/ui/revealable-input"
import { Input } from "@/components/ui/input"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp"
import { CopySecurityCode } from "@/components/admin/CopySecurityCode"

export async function securityRequest<T>(
  jwt: string,
  path = "",
  body?: object,
): Promise<T> {
  const response = await fetch(
    `${AUTH_BASE}/api/v2/auth/security${path ? `/${path}` : ""}`,
    {
      method: body ? "POST" : "GET",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  )
  if (response.status === 401) void notifySessionExpiredIfCurrent(jwt)
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || "unavailable")
  return result as T
}
export function SecurityCode({
  value,
  onChange,
}: {
  value: string
  onChange: (s: string) => void
}) {
  const t = useT()
  return (
    <InputOTP
      aria-label={t("auth.security.authenticatorCode")}
      maxLength={6}
      pattern="^[0-9]*$"
      value={value}
      onChange={onChange}
    >
      <InputOTPGroup>
        {Array.from({ length: 6 }, (_, i) => (
          <InputOTPSlot key={i} index={i} />
        ))}
      </InputOTPGroup>
    </InputOTP>
  )
}
export function AccountSecurity({
  jwt,
  username,
  children,
}: {
  jwt: string
  username: string
  children: ReactNode
}) {
  const t = useT()
  const passwordId = useId()
  const [status, setStatus] = useState<{
    enabled: boolean
    configured: boolean
    verified: boolean
    google_available: boolean
    password: boolean
    google: boolean
    google_verified: boolean
  } | null>(null)
  const [enrolling, setEnrolling] = useState(false)
  const [setup, setSetup] = useState<{
    secret: string
    generation: string
    uri: string
    qr: string
  } | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null),
    [code, setCode] = useState(""),
    [password, setPassword] = useState("")
  const [recovery, setRecovery] = useState(false),
    [saved, setSaved] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  const refresh = async () => setStatus(await securityRequest(jwt))
  useEffect(() => {
    let alive = true
    const load = () =>
      void securityRequest<NonNullable<typeof status>>(jwt)
        .then((s) => {
          if (alive) setStatus(s)
        })
        .catch(() => {
          if (alive) {
            setStatus(null)
            setError(t("auth.security.unableToLoadSecuritySettingsTryAgain"))
          }
        })
    load()
    const timer = window.setInterval(load, 30000)
    window.addEventListener("focus", load)
    return () => {
      alive = false
      window.clearInterval(timer)
      window.removeEventListener("focus", load)
    }
  }, [jwt, t])
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError("")
    try {
      await work()
    } catch (e) {
      setError(
        e instanceof Error && e.message === "rate_limited"
          ? t("auth.security.tooManyAttemptsWaitFiveMinutesAndTry")
          : t("auth.security.verificationFailedOrExpiredCheckYourPasswordOr"),
      )
    } finally {
      setBusy(false)
      setCode("")
      setPassword("")
    }
  }
  const locked = status?.enabled && !status.verified
  const closeSetup = () => {
    if (busy || codes) return
    setEnrolling(false)
    setSetup(null)
    setCode("")
    setPassword("")
    setRecovery(false)
    setError("")
  }
  const form = (
    <div className="flex flex-col gap-4 ph-no-capture" data-ph-mask>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {!status ? (
        <Button onClick={() => void run(refresh)}>
          {t("auth.security.reloadSecuritySettings")}
        </Button>
      ) : (
        <>
          {locked && (
            <p>
              {t("auth.security.verifyWithYourAuthenticatorAppToManageYour")}
            </p>
          )}
          {setup && !codes && (
            <>
              <p>{t("auth.security.scanThisQRCodeInYourAuthenticatorApp")}</p>
              <img
                src={setup.qr}
                alt={t("auth.security.authenticatorSetupQRCode")}
                className="self-center rounded-md border bg-white p-3"
                width={200}
                height={200}
              />
              <CopySecurityCode
                value={setup.secret}
                label={t("auth.security.copySetupKey")}
              />
            </>
          )}
          {(status.enabled || setup) && !codes && (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                if (busy || !code) return
                void run(async () => {
                  if (setup) {
                    const result = await securityRequest<{
                      recoveryCodes: string[]
                    }>(jwt, "confirm", {
                      generation: setup.generation,
                      code,
                    })
                    setCodes(result.recoveryCodes)
                  } else {
                    await securityRequest(jwt, "verify", {
                      code,
                      recovery,
                    })
                    await refresh()
                  }
                })
              }}
            >
              {recovery ? (
                <Input
                  aria-label={t("auth.security.recoveryCode")}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              ) : (
                <SecurityCode value={code} onChange={setCode} />
              )}
              {status.enabled && (
                <Button
                  type="button"
                  variant="link"
                  onClick={() => {
                    setRecovery(!recovery)
                    setCode("")
                  }}
                >
                  {recovery
                    ? t("auth.security.useAnAuthenticatorCode")
                    : t("auth.security.useARecoveryCode")}
                </Button>
              )}
              <Button type="submit" disabled={busy || !code}>
                {setup
                  ? t("auth.security.confirmAuthenticator")
                  : t("auth.security.verify")}
              </Button>
              {status.enabled && !locked && (
                <div className="flex flex-wrap gap-2">
                  <p className="w-full text-sm text-muted-foreground">
                    {t("auth.security.turnOffWarning")}
                  </p>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={busy || !code}
                    onClick={() =>
                      void run(async () => {
                        await securityRequest(jwt, "verify", {
                          code,
                          recovery,
                          disable: true,
                        })
                        setEnrolling(false)
                        await refresh()
                      })
                    }
                  >
                    {t("auth.security.turnOffProtection")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || !code}
                    onClick={() =>
                      void run(async () => {
                        const r = await securityRequest<{
                          recoveryCodes: string[]
                        }>(jwt, "verify", {
                          code,
                          recovery,
                          regenerate: true,
                        })
                        setCodes(r.recoveryCodes)
                        await refresh()
                      })
                    }
                  >
                    {t("auth.security.replaceRecoveryCodes")}
                  </Button>
                </div>
              )}
            </form>
          )}
          {!status.enabled && !setup && status.configured && enrolling && (
            <>
              {status.password && (
                <form
                  className="flex flex-col gap-4"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (busy || !password) return
                    void run(async () => {
                      await securityRequest(jwt, "password-proof", {
                        password,
                      })
                      const s = await securityRequest<{
                        secret: string
                        generation: string
                        uri: string
                      }>(jwt, "setup", {})
                      setSetup({ ...s, qr: await QRCode.toDataURL(s.uri) })
                    })
                  }}
                >
                  <label htmlFor={passwordId}>
                    {t("auth.security.currentAquillaPassword")}
                  </label>
                  <RevealableInput
                    id={passwordId}
                    aria-label={t("auth.security.currentAquillaPassword")}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <Button type="submit" disabled={busy || !password}>
                    {t("auth.security.setUpWithYourPassword")}
                  </Button>
                </form>
              )}
              {status.google && !status.google_verified && (
                <Button
                  variant="outline"
                  disabled={busy || !status.google_available}
                  onClick={() =>
                    void run(async () =>
                      startGoogleLogin(
                        "/preferences/login-methods",
                        false,
                        username,
                        false,
                        undefined,
                        false,
                        true,
                      ),
                    )
                  }
                >
                  {t("auth.security.verifyWithGoogleInstead")}
                </Button>
              )}
              {status.google_verified && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const s = await securityRequest<{
                        secret: string
                        generation: string
                        uri: string
                      }>(jwt, "setup", {})
                      setSetup({ ...s, qr: await QRCode.toDataURL(s.uri) })
                    })
                  }
                >
                  {t("auth.security.continueAfterGoogleVerification")}
                </Button>
              )}
            </>
          )}
          {!status.enabled && !status.configured && (
            <p>
              {t(
                "auth.security.authenticatorSetupIsUnavailableInThisEnvironment",
              )}
            </p>
          )}
          {codes && (
            <>
              <p>
                {t(
                  "auth.security.saveTheseRecoveryCodesSomewhereSeparateFromYour",
                )}
              </p>
              <pre className="select-none" data-ph-mask>
                {codes.join("\n")}
              </pre>
              <CopySecurityCode
                value={codes.join("\n")}
                label={t("auth.security.copyRecoveryCodes")}
              />
              <label>
                <input
                  type="checkbox"
                  checked={saved}
                  onChange={(e) => setSaved(e.target.checked)}
                />
                {t("auth.security.iSavedMyRecoveryCodes")}
              </label>
              <Button
                disabled={!saved || busy}
                onClick={() =>
                  void run(async () => {
                    if (setup)
                      await securityRequest(jwt, "complete", {
                        generation: setup.generation,
                        savedRecoveryCodes: true,
                      })
                    setEnrolling(false)
                    setCodes(null)
                    setSetup(null)
                    setSaved(false)
                    await refresh()
                  })
                }
              >
                {t("auth.security.done")}
              </Button>
            </>
          )}
        </>
      )}
    </div>
  )
  return (
    <div className="flex flex-col gap-6" data-testid="account-login-security">
      <SettingsGroup>
        <SettingsRow
          className="flex-wrap items-center"
          label={t("auth.security.protectYourLoginSettings")}
          description={
            status?.enabled
              ? t("auth.security.protectionEnabled")
              : status && !status.configured
                ? t(
                    "auth.security.authenticatorSetupIsUnavailableInThisEnvironment",
                  )
                : t("auth.security.useAnAuthenticatorAppToApproveChangesTo")
          }
          control={
            status && !locked ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!status.enabled && !status.configured}
                onClick={() => setEnrolling(true)}
              >
                {t(
                  status.enabled
                    ? "auth.security.manageProtection"
                    : "auth.security.enableProtection",
                )}
              </Button>
            ) : undefined
          }
        />
      </SettingsGroup>
      {(!status || locked) && <section className="max-w-md">{form}</section>}
      <Dialog
        open={enrolling && !locked}
        onOpenChange={(open) => {
          if (!open) closeSetup()
        }}
      >
        <DialogContent closeDisabled={busy || !!codes}>
          <DialogHeader>
            <DialogTitle>
              {t(
                codes
                  ? "auth.security.saveRecoveryCodes"
                  : status?.enabled
                    ? "auth.security.manageProtection"
                    : "auth.security.enableProtection",
              )}
            </DialogTitle>
            <DialogDescription>
              {t("auth.security.useAnAuthenticatorAppToApproveChangesTo")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>{form}</DialogBody>
        </DialogContent>
      </Dialog>
      {status && !locked && children}
    </div>
  )
}

export function PasswordManagement({
  jwt,
  username,
  google,
  googleAvailable,
  passwordSet,
  onChanged,
}: {
  jwt: string
  username: string
  google: boolean
  googleAvailable: boolean
  passwordSet: boolean
  onChanged: () => void
}) {
  const t = useT()
  const { adopt } = useAccounts()
  const currentId = useId(),
    newId = useId()
  const [current, setCurrent] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmed, setConfirmed] = useState(false)
  const run = async (remove = false) => {
    setBusy(true)
    setError("")
    try {
      if (current)
        await securityRequest(jwt, "password-proof", { password: current })
      if (remove) {
        const r = await securityRequest<{
          access_token: string
          username: string
          token_type: string
        }>(jwt, "remove-password", {})
        await adopt(await finalizeSession(r.username, r))
      } else {
        const r = await securityRequest<{
          access_token: string
          username: string
          token_type: string
        }>(jwt, "password", { password })
        await adopt(await finalizeSession(r.username, r))
      }
      setPassword("")
      setCurrent("")
      setConfirmed(false)
      onChanged()
    } catch (e) {
      setError(
        e instanceof Error && e.message === "settings_verification_required"
          ? t("auth.security.verifyYourLoginSettingsAgainBeforeContinuing")
          : e instanceof Error && e.message === "invalid_password"
            ? t("auth.security.wrongPassword")
            : e instanceof Error && e.message === "rate_limited"
              ? t("auth.security.tooManyAttemptsWaitFiveMinutesAndTry")
              : t("auth.security.verifyYourCurrentPasswordOrGoogleAccountThen"),
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className="flex max-w-xl flex-col gap-3 ph-no-capture"
      data-ph-mask
    >
      <h3 className="font-medium">
        {passwordSet
          ? t("auth.security.manageYourPassword")
          : t("auth.security.addABackupPassword")}
      </h3>
      {!passwordSet && (
        <p>{t("auth.security.setAnAquillaPasswordSoYouCanStill")}</p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {passwordSet && (
        <>
          <label htmlFor={currentId}>
            {t("auth.security.currentPassword")}
          </label>
          <RevealableInput
            id={currentId}
            aria-label={t("auth.security.currentPassword")}
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </>
      )}
      {google && (
        <Button
          variant="outline"
          disabled={busy || !googleAvailable}
          onClick={() => {
            setError("")
            void startGoogleLogin(
              "/preferences/login-methods",
              false,
              username,
              false,
              undefined,
              false,
              true,
            ).catch(() => setError(t("auth.methods.connectFailed")))
          }}
        >
          {t("auth.security.verifyWithGoogle")}
        </Button>
      )}
      <label htmlFor={newId}>{t("auth.security.newAquillaPassword")}</label>
      <RevealableInput
        id={newId}
        aria-label={t("auth.security.newAquillaPassword")}
        autoComplete="new-password"
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Button disabled={busy || password.length < 8} onClick={() => void run()}>
        {passwordSet
          ? t("auth.security.changePassword")
          : t("auth.security.setAPassword")}
      </Button>
      {passwordSet && google && (
        <>
          <p>{t("auth.security.removingYourPasswordMeansYoullNeedGoogleTo")}</p>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {t("auth.security.iWantToRemoveMyAquillaPassword")}
          </label>
          <Button
            variant="destructive"
            disabled={busy || !confirmed}
            onClick={() => void run(true)}
          >
            {t("auth.security.removePassword")}
          </Button>
        </>
      )}
    </section>
  )
}
