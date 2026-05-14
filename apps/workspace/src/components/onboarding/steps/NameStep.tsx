import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useFrontierSession } from "@/hooks/useFrontierSession"

export function NameStep({
  value,
  onChange,
  onNext,
  onBack,
}: {
  value: string
  onChange: (v: string) => void
  onNext: () => void
  onBack: () => void
}) {
  const { session } = useFrontierSession()

  // Pre-fill from Frontier session if user hasn't typed anything yet
  useEffect(() => {
    if (session?.username && !value) {
      onChange(session.username)
    }
  }, [session?.username])

  function handleContinue() {
    const name = value.trim() || "Anonymous"
    localStorage.setItem("codex:username", name)
    onChange(name)
    onNext()
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-semibold">What should we call you?</h2>
        <p className="text-sm text-muted-foreground">
          This name appears on your edits and comments.
        </p>
      </div>
      <div>
        <Label htmlFor="display-name">Display name</Label>
        <Input
          id="display-name"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Anonymous translator"
          autoFocus
        />
      </div>
      <Button size="lg" onClick={handleContinue} className="w-full">
        Continue
      </Button>
      <Button variant="ghost" size="sm" onClick={onBack} className="w-full">
        ← Back
      </Button>
    </div>
  )
}
