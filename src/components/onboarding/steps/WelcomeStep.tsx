import { Button } from "@/components/ui/button"

export function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="text-center space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Welcome to Codex</h1>
        <p className="text-muted-foreground">
          A collaborative translation editor with AI assistance.
        </p>
      </div>
      <Button size="lg" onClick={onNext} className="w-full">
        Get Started
      </Button>
    </div>
  )
}
