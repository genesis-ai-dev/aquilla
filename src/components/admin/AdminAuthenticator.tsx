import { useEffect, useRef, useState } from "react"
import QRCode from "qrcode"
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
      <h2 className="text-lg font-medium">Admin authenticator</h2>
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
          <p>
            TOTP is enabled. Use your authenticator or a recovery code. Email
            cannot be used as a backup.
          </p>
          <p>
            To remove it and return to email verification, enter a fresh code.
            You will need to verify again afterward.
          </p>
          <label className="block">
            {recovery ? "Recovery code" : "Authenticator code"}
            <Input
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <Button
            variant="ghost"
            onClick={() => {
              setRecovery(!recovery)
              setCode("")
            }}
          >
            {recovery ? "Use authenticator" : "Use a recovery code"}
          </Button>
          <Button
            disabled={busy || !code}
            variant="outline"
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
            Remove authenticator
          </Button>
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
              <code className="block break-all select-text">
                {setup.secret}
              </code>
              <CopySecurityCode value={setup.secret} label="Copy setup key" />
              <label className="block">
                Authenticator code
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
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
                Enable TOTP.
              </p>
              <pre className="select-text whitespace-pre-wrap rounded border p-4">
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
                Enable TOTP
              </Button>
            </>
          )}
        </>
      )}
    </section>
  )
}
