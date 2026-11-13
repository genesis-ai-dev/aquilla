import { useEffect, useRef, useState } from "react"
import QRCode from "qrcode"
import { REGEXP_ONLY_DIGITS } from "input-otp"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { adminTotp } from "@/lib/frontier/admin"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CopySecurityCode } from "./CopySecurityCode"
import { AdminElevationGate } from "./AdminElevationGate"

/** Keying by credential discards secrets and codes on account/session changes. */
export function AdminAuthenticator({ jwt }: { jwt: string }) {
  return <Authenticator key={jwt} jwt={jwt} />
}
function Authenticator({ jwt }: { jwt: string }) {
  const [status, setStatus] = useState<{
    enabled: boolean
    configured: boolean
  } | null>(null)
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(
    null,
  )
  const [codes, setCodes] = useState<string[] | null>(null)
  const [generation, setGeneration] = useState("")
  const [saved, setSaved] = useState(false)
  const [code, setCode] = useState("")
  const [recovery, setRecovery] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [fresh, setFresh] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    let alive = true
    void adminTotp<{ enabled: boolean; configured: boolean }>(jwt)
      .then((s) => {
        if (alive) setStatus(s)
      })
      .catch(() => {
        if (alive)
          setError("Unable to load authenticator settings. Reload to retry.")
      })
    return () => {
      alive = false
      mounted.current = false
    }
  }, [jwt])
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError("")
    try {
      await action()
    } catch {
      setError(
        "Verification failed or expired. Check your code and try again. To start setup, verify your admin session again first.",
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className="max-w-xl flex flex-col gap-4 ph-no-capture"
      data-ph-mask
    >
      <h2 className="text-lg font-medium">Admin verification</h2>
      {!fresh && !setup && !codes && (
        <p className="text-sm text-muted-foreground">
          Use Apple Passwords or another authenticator for admin verification.
          This does not change your login methods or admin permissions.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {!status ? (
        <p>Loading…</p>
      ) : !status.configured ? (
        <p>
          Authenticator setup requires server configuration. Your existing
          verification method is unchanged.
        </p>
      ) : status.enabled ? (
        <>
          {!removing ? (
            <>
              <p className="font-medium">Authenticator app is on</p>
              <p className="text-sm text-muted-foreground">
                Verify admin access with a code from Apple Passwords or your
                authenticator app, or use a recovery code. Email codes are off.
              </p>
              <Button
                variant="destructive"
                className="self-start"
                onClick={() => setRemoving(true)}
              >
                Turn off authenticator app
              </Button>
            </>
          ) : (
            <div className="flex flex-col gap-4 rounded-lg border border-destructive/30 p-4">
              <div role="alert" className="flex flex-col gap-2">
                <h3 className="font-medium">Turn off your authenticator app?</h3>
                <p className="text-sm">
                  Admin verification will switch to codes sent to your account’s
                  email address. Make sure you can receive email there before
                  continuing. Your current authenticator setup and recovery codes
                  will stop working.
                </p>
                <p className="text-sm text-muted-foreground">
                  Enter a current authenticator code or a recovery code to
                  confirm. You’ll need to verify again using email afterward.
                </p>
              </div>
              <label className="block">
                {recovery ? "Recovery code" : "Authenticator code"}
                {recovery ? (
                  <Input autoComplete="off" disabled={busy} value={code}
                    onChange={(e) => setCode(e.target.value)} />
                ) : (
                  <AuthenticatorCode value={code} onChange={setCode} disabled={busy} />
                )}
              </label>
              <Button
                variant="ghost"
                className="self-start"
                disabled={busy}
                onClick={() => {
                  setRecovery(!recovery)
                  setCode("")
                }}
              >
                {recovery ? "Use an authenticator code" : "Use a recovery code"}
              </Button>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setRemoving(false)
                    setCode("")
                    setRecovery(false)
                    setError("")
                  }}
                >
                  Cancel
                </Button>
                <Button
                  disabled={busy || (recovery ? !code.trim() : !/^\d{6}$/.test(code))}
                  variant="destructive"
                  onClick={() =>
                    void run(async () => {
                      await adminTotp(jwt, "verify", {
                        code,
                        recovery,
                        disable: true,
                      })
                      if (mounted.current) window.location.reload()
                    })
                  }
                >
                  Turn off and use email codes
                </Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {!fresh && !setup && !codes && (
            <p>
              Email verification stays available until you finish every setup
              step.
            </p>
          )}
          {!fresh && !setup && !codes && (
            <Button
              className="self-start"
              disabled={busy}
              onClick={() => setFresh(true)}
            >
              Verify and set up authenticator
            </Button>
          )}
          {fresh && (
            <>
              <AdminElevationGate
                jwt={jwt}
                email={null}
                compact
                description="Confirm it’s you before setting up your authenticator. Request a one-time email code to continue."
                onElevated={() => {
                  setFresh(false)
                  void run(async () => {
                    const s = await adminTotp<{
                      generation: string
                      secret: string
                      uri: string
                    }>(jwt, "setup", {})
                    setGeneration(s.generation)
                    setSetup({
                      secret: s.secret,
                      qr: await QRCode.toDataURL(s.uri),
                    })
                  })
                }}
              />
              <Button
                variant="ghost"
                className="self-start"
                onClick={() => setFresh(false)}
              >
                Back
              </Button>
            </>
          )}
          {setup && !codes && (
            <>
              <p>
                Scan this QR code with your authenticator, or enter the setup
                key manually. Keep this key private.
              </p>
              <img
                src={setup.qr}
                alt="Authenticator setup QR code"
                className="size-48"
              />
              <code className="block break-all select-none">
                {setup.secret}
              </code>
              <CopySecurityCode value={setup.secret} label="Copy setup key" />
              <label className="block">
                Authenticator code
                <AuthenticatorCode value={code} onChange={setCode} disabled={busy} />
              </label>
              <Button
                disabled={busy || !/^\d{6}$/.test(code)}
                onClick={() =>
                  void run(async () => {
                    const r = await adminTotp<{ recoveryCodes: string[] }>(
                      jwt,
                      "confirm",
                      { code, generation },
                    )
                    setCodes(r.recoveryCodes)
                    setSetup(null)
                    setCode("")
                  })
                }
              >
                Confirm authenticator
              </Button>
            </>
          )}
          {codes && (
            <>
              <p>
                Save these recovery codes somewhere safe. Each works once. They
                will not be shown again. Email still works until you select
                Enable authenticator app.
              </p>
              <pre className="select-none whitespace-pre-wrap rounded border p-4">
                {codes.join("\n")}
              </pre>
              <CopySecurityCode
                value={codes.join("\n")}
                label="Copy recovery codes"
              />
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={saved}
                  onChange={(e) => setSaved(e.target.checked)}
                />
                I have saved my recovery codes
              </label>
              <Button
                disabled={busy || !saved}
                onClick={() =>
                  void run(async () => {
                    await adminTotp(jwt, "complete", {
                      savedRecoveryCodes: true,
                      generation,
                    })
                    setCodes(null)
                    if (mounted.current) window.location.reload()
                  })
                }
              >
                Enable authenticator app
              </Button>
            </>
          )}
        </>
      )}
    </section>
  )
}

function AuthenticatorCode({ value, onChange, disabled }: {
  value: string
  onChange: (value: string) => void
  disabled: boolean
}) {
  return (
    <InputOTP maxLength={6} pattern={REGEXP_ONLY_DIGITS} inputMode="numeric"
      autoComplete="one-time-code" aria-label="Authenticator code"
      value={value} onChange={onChange} disabled={disabled}>
      <InputOTPGroup>
        {Array.from({ length: 6 }, (_, index) => <InputOTPSlot key={index} index={index} />)}
      </InputOTPGroup>
    </InputOTP>
  )
}
