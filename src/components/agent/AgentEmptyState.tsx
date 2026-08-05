import { Bot } from "lucide-react"

/** A deliberately quiet landing state; examples live in the composer hint. */
export function AgentEmptyState() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-3 text-center text-muted-foreground">
      <Bot className="h-5 w-5" />
      <p className="text-xs">What should we work on?</p>
    </div>
  )
}
