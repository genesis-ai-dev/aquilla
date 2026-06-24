import { useEffect, useState } from "react"
import { useSearchParams, useNavigate } from "react-router-dom"
import { CheckCircle2, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { verifyEmail } from "@/lib/frontier/auth"

type Phase = "verifying" | "done" | "error"

/**
 * Email-verification landing page (/verify-email?token=…). Soft verification:
 * it confirms the address but the user is never blocked from using Aquilla, so
 * this page is purely confirmatory — success just reassures and points home.
 */
export function VerifyEmailPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get("token")
  const [phase, setPhase] = useState<Phase>("verifying")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) {
      setError("This verification link is missing its token.")
      setPhase("error")
      return
    }
    let cancelled = false
    void (async () => {
      try {
        await verifyEmail(token)
        if (!cancelled) setPhase("done")
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Verification failed.")
          setPhase("error")
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        {phase === "verifying" && (
          <CardContent className="flex items-center justify-center gap-2 py-10">
            <Spinner /> <span className="text-sm">Verifying your email…</span>
          </CardContent>
        )}
        {phase === "done" && (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="size-5 text-green-600" /> Email verified
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Thanks — your email address is confirmed.
              </p>
              <Button onClick={() => navigate("/")}>Go to Aquilla</Button>
            </CardContent>
          </>
        )}
        {phase === "error" && (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertCircle className="size-5 text-destructive" /> Couldn't verify
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">{error}</p>
              <p className="text-xs text-muted-foreground">
                You can still use Aquilla — verification isn't required to sign in.
              </p>
              <Button variant="outline" onClick={() => navigate("/")}>Go to Aquilla</Button>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  )
}
