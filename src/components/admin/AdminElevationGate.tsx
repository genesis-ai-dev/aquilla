import { useCallback, useRef, useState } from "react"
import { ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
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

  const sendCode = useCallback(async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
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
    async (code: string) => {
      setBusy(true)
      setError(null)
      try {
        await verifyAdminElevation(jwt, code)
        onElevated()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [jwt, onElevated],
  )

  return (
    <div className="mx-auto mt-10 max-w-md rounded-2xl border bg-card p-6 text-center">
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
          <CodeInput onComplete={verify} disabled={busy} />
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

/**
 * Six single-character boxes with auto-advance + paste support. Calls
 * `onComplete` once all six digits are present (Enter also submits).
 */
function CodeInput({
  onComplete,
  disabled,
}: {
  onComplete: (code: string) => void
  disabled: boolean
}) {
  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(""))
  const refs = useRef<Array<HTMLInputElement | null>>([])

  const setAt = (i: number, v: string) => {
    setDigits((prev) => {
      const next = [...prev]
      next[i] = v
      return next
    })
  }

  const submitIfComplete = (next: string[]) => {
    const code = next.join("")
    if (code.length === CODE_LENGTH && next.every((d) => d !== "")) onComplete(code)
  }

  const handleChange = (i: number, raw: string) => {
    const v = raw.replace(/\D/g, "")
    if (!v) {
      setAt(i, "")
      return
    }
    // Support pasting/typing multiple digits at once.
    const chars = v.split("")
    setDigits((prev) => {
      const next = [...prev]
      let idx = i
      for (const ch of chars) {
        if (idx >= CODE_LENGTH) break
        next[idx] = ch
        idx++
      }
      const focusIdx = Math.min(idx, CODE_LENGTH - 1)
      refs.current[focusIdx]?.focus()
      submitIfComplete(next)
      return next
    })
  }

  const handleKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !digits[i] && i > 0) {
      refs.current[i - 1]?.focus()
    } else if (e.key === "Enter") {
      submitIfComplete(digits)
    }
  }

  return (
    <div className="flex justify-center gap-2" role="group" aria-label="Verification code">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={CODE_LENGTH}
          value={d}
          disabled={disabled}
          aria-label={`Digit ${i + 1}`}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          className="size-11 rounded-lg border bg-background text-center font-mono text-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        />
      ))}
    </div>
  )
}
