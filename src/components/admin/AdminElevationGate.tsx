import { useCallback, useState } from "react"
import { REGEXP_ONLY_DIGITS } from "input-otp"
import { ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp"
import { requestAdminElevation, verifyAdminElevation } from "@/lib/frontier/admin"

const CODE_LENGTH = 6

/**
 * Step-up "sudo" gate shown before the admin console when hardening is on.
 * Two phases: request a code (emailed to the operator's @company address), then
 * enter the 6-digit code to mint a ~6h elevated session. The worker is the real
 * gate — this only drives the request/verify endpoints and calls `onElevated`
 * (which re-probes /me) on success.
 */
export function AdminElevationGate({
  jwt,
  email,
  onElevated,
}: {
  jwt: string
  email: string | null
  onElevated: () => void
}) {
  const [phase, setPhase] = useState<"request" | "verify">("request")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [code, setCode] = useState("")

  const sendCode = useCallback(async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    setCode("")
    try {
      const { sent, devCode } = await requestAdminElevation(jwt)
      setPhase("verify")
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
        await verifyAdminElevation(jwt, nextCode)
        onElevated()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setCode("")
      } finally {
        setBusy(false)
      }
    },
    [jwt, onElevated],
  )

  return (
    <div className="mx-auto mt-10 max-w-md rounded-lg border bg-card p-6 text-center">
      <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <ShieldCheck className="size-6" />
      </div>
      <h2 className="font-heading text-lg font-medium">Admin verification required</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The admin console is protected. Confirm it's you with a one-time code sent to your
        company email.
      </p>

      {phase === "request" ? (
        <div className="mt-6 space-y-3">
          <Button type="button" onClick={sendCode} disabled={busy} className="w-full">
            {busy ? "Sending…" : "Email me a code"}
          </Button>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
          <div className="flex justify-center">
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
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center justify-center gap-2 text-xs">
            <button
              type="button"
              onClick={sendCode}
              disabled={busy}
              className="text-primary hover:underline disabled:opacity-50"
            >
              Resend code
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
