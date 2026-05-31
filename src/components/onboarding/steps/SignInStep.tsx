import { useState } from "react"
import { Button } from "@/components/ui/button"
import { FrontierLoginForm } from "@/components/git-import/FrontierLoginForm"
import { FrontierSignupForm } from "@/components/git-import/FrontierSignupForm"
import { FrontierForgotPasswordForm } from "@/components/git-import/FrontierForgotPasswordForm"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { devLogin } from "@/lib/frontier/auth"
import { Check } from "lucide-react"

type Mode = "signup" | "login" | "forgot"

export function SignInStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { session } = useFrontierSession()
  // Default new visitors to signup; the loop's "joiner" path is rare here
  // (joiners arrive via invite links, not the onboarding wizard).
  const [mode, setMode] = useState<Mode>("signup")

  if (session) {
    return (
      <div className="space-y-6">
        <div className="text-center space-y-2">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-green-600">
            <Check className="h-6 w-6" />
          </div>
          <h2 className="text-2xl font-semibold">Signed in as {session.username}</h2>
          <p className="text-sm text-muted-foreground">
            AI translations, sync, and cloud import are available.
          </p>
        </div>
        <Button size="lg" onClick={onNext} className="w-full">
          Continue
        </Button>
      </div>
    )
  }

  const isSignup = mode === "signup"
  const isForgot = mode === "forgot"

  const headings: Record<Mode, string> = {
    signup: "Create your Frontier account",
    login: "Sign in to Frontier",
    forgot: "Reset your password",
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-semibold">{headings[mode]}</h2>
        <p className="text-sm text-muted-foreground">
          Unlock AI-powered translations, sync across devices, and import projects from the cloud.
        </p>
      </div>

      {mode === "signup" && <FrontierSignupForm onSuccess={onNext} />}
      {mode === "login" && (
        <FrontierLoginForm
          onSuccess={onNext}
          onForgotPassword={() => setMode("forgot")}
        />
      )}
      {mode === "forgot" && (
        <FrontierForgotPasswordForm onBack={() => setMode("login")} />
      )}

      {!isForgot && (
        <p className="text-center text-sm text-muted-foreground">
          {isSignup ? "Already have an account?" : "New to Frontier?"}{" "}
          <button
            type="button"
            onClick={() => setMode(isSignup ? "login" : "signup")}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            {isSignup ? "Log in" : "Create one"}
          </button>
        </p>
      )}

      <div className="text-center">
        <button
          type="button"
          onClick={onNext}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Skip for now
        </button>
      </div>
      {import.meta.env.DEV && (
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const session = await devLogin()
            if (session) onNext()
            else console.warn("[dev-login] endpoint unavailable — is WRANGLER_LOCAL=1 set on auth-worker?")
          }}
          className="w-full"
        >
          Dev login (skip auth)
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onBack} className="w-full">
        ← Back
      </Button>
    </div>
  )
}
