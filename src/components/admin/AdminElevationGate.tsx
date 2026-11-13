import { useCallback, useEffect, useRef, useState } from "react"
import { REGEXP_ONLY_DIGITS } from "input-otp"
import { ShieldCheck } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp"
import {
  adminTotp,
  requestAdminElevation,
  verifyAdminElevation,
} from "@/lib/frontier/admin"

import { cn } from "@/lib/utils"
import { CopySecurityCode } from "./CopySecurityCode"

const CODE_LENGTH = 6

const CONSOLE_DESCRIPTION =
  "The admin console is protected. Confirm it's you with a one-time code sent to your company email."

/**
 * Step-up "sudo" gate shown before the admin console when hardening is on.
 * Email is offered until enrollment completes; enrolled operators must use
 * an authenticator or recovery code to mint an elevated session. The worker is the real
 * gate — this only drives the request/verify endpoints and calls `onElevated`
 * (which re-probes /me) on success.
 */
export function AdminElevationGate(props: {
  jwt: string
  email: string | null
  onElevated: () => void
  description?: string
  compact?: boolean
}) {
  return <ElevationGate key={props.jwt} {...props} />
}

function ElevationGate({
  jwt,
  email,
  onElevated,
  description = CONSOLE_DESCRIPTION,
  compact = false,
}: {
  jwt: string
  email: string | null
  onElevated: () => void
  /** Override the intro line (the global step-up dialog words it for a single change). */
  description?: string
  compact?: boolean
}) {
  const [method, setMethod] = useState<
    "loading" | "email" | "totp" | "recovery" | "error"
  >("loading")
  const [phase, setPhase] = useState<"request" | "verify">("request")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [developmentCode, setDevelopmentCode] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    let active = true
    void adminTotp<{ enabled: boolean }>(jwt)
      .then((s) => {
        if (active) {
          setMethod(s.enabled ? "totp" : "email")
          if (s.enabled) setPhase("verify")
        }
      })
      .catch(() => {
        if (active) setMethod("error")
      })
    return () => {
      active = false
      alive.current = false
    }
  }, [jwt])

  const sendCode = useCallback(async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    setDevelopmentCode(null)
    setCode("")
    try {
      const { sent, devCode } = await requestAdminElevation(jwt)
      if (!alive.current) return
      setPhase("verify")
      setDevelopmentCode(devCode ?? null)
      // Dev/e2e: no mail binding → the server hands back the code so the flow
      // is testable. Never happens in production.
      setNotice(
        devCode
          ? `Dev mode — your code is ${devCode}`
          : sent
            ? `We emailed a 6-digit code${email ? ` to ${email}` : ""}.`
            : "Code generated. Check your email.",
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [jwt, email])

  const verify = useCallback(
    async (nextCode: string) => {
      setBusy(true)
      setError(null)
      try {
        if (method === "email") await verifyAdminElevation(jwt, nextCode)
        else
          await adminTotp(jwt, "verify", {
            code: nextCode,
            recovery: method === "recovery",
          })
        if (alive.current) onElevated()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setCode("")
      } finally {
        setBusy(false)
      }
    },
    [jwt, onElevated, method],
  )

  return (
    <div
      data-ph-mask
      className={cn(
        "ph-no-capture max-w-md",
        compact
          ? "flex flex-col gap-3"
          : "mx-auto mt-10 rounded-lg border bg-card p-6 text-center",
      )}
    >
      {!compact && (
        <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <ShieldCheck className="size-6" />
        </div>
      )}
      <h2 className="font-heading text-lg font-medium">
        Admin verification required
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {method === "totp" || method === "recovery"
          ? "Verify with your authenticator or a single-use recovery code."
          : description}
      </p>
      {method === "loading" && <p>Loading verification options…</p>}
      {method === "error" && (
        <p role="alert">
          Unable to load verification options. Reload to retry.
        </p>
      )}

      {method === "loading" || method === "error" ? null : phase ===
        "request" ? (
        <div className={cn("flex flex-col gap-3", !compact && "mt-6")}>
          <Button
            type="button"
            onClick={sendCode}
            disabled={busy}
            className="w-full"
          >
            {busy ? "Sending…" : "Email me a code"}
          </Button>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      ) : (
        <div className={cn("flex flex-col gap-4", !compact && "mt-6")}>
          {notice && (
            <p className="select-text text-xs text-muted-foreground">
              {notice}
            </p>
          )}
          {developmentCode && (
            <CopySecurityCode
              key={developmentCode}
              value={developmentCode}
              label="Copy code"
            />
          )}
          <div className={cn("flex", !compact && "justify-center")}>
            {method === "recovery" ? (
              <div>
                <Input
                  aria-label="Recovery code"
                  autoComplete="off"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <Button
                  disabled={busy || !code}
                  onClick={() => void verify(code)}
                >
                  Verify recovery code
                </Button>
              </div>
            ) : (
              <InputOTP
                maxLength={CODE_LENGTH}
                pattern={REGEXP_ONLY_DIGITS}
                value={code}
                onChange={setCode}
                onComplete={verify}
                disabled={busy}
                autoComplete="one-time-code"
                inputMode="numeric"
                aria-label="Verification code"
                containerClassName="gap-0"
                // OTP fields don't get password-manager badges; probing them
                // polls `window` on an interval that survives happy-dom teardown.
                pushPasswordManagerStrategy="none"
              >
                <InputOTPGroup>
                  {Array.from({ length: CODE_LENGTH }, (_, i) => (
                    <InputOTPSlot
                      key={i}
                      index={i}
                      className="size-11 font-mono text-lg"
                    />
                  ))}
                </InputOTPGroup>
              </InputOTP>
            )}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          {method !== "email" ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setMethod(method === "recovery" ? "totp" : "recovery")
                setCode("")
              }}
            >
              {method === "recovery"
                ? "Use authenticator"
                : "Use a recovery code"}
            </Button>
          ) : (
            <div
              className={cn(
                "flex items-center gap-2 text-xs",
                !compact && "justify-center",
              )}
            >
              <button
                type="button"
                onClick={sendCode}
                disabled={busy}
                className="text-primary hover:underline disabled:opacity-50"
              >
                Resend code
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
