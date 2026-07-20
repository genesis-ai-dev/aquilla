import { useState } from "react"
import { MessageSquare, Bot, Plus, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface ModelListValue {
  models: string[]
  chatModel: string
  agentModel: string
}

/**
 * One managed list of allowed model IDs, and the source of truth for which one
 * is the default chat model and which is the agent model. Replaces the old
 * pattern where a free-text <textarea> silently populated two dropdowns — here
 * you add a model once, then mark it Chat / Agent right on its row, so a default
 * can never point at a model that isn't allowed. Fully controlled.
 */
export function ModelListEditor({
  value,
  onChange,
}: {
  value: ModelListValue
  onChange: (next: ModelListValue) => void
}) {
  const { models, chatModel, agentModel } = value
  const [draft, setDraft] = useState("")

  const addModel = () => {
    const id = draft.trim()
    if (!id || models.includes(id)) {
      setDraft("")
      return
    }
    const nextModels = [...models, id]
    // First model added becomes the default for whichever role is still unset.
    onChange({
      models: nextModels,
      chatModel: chatModel || id,
      agentModel: agentModel || id,
    })
    setDraft("")
  }

  const removeModel = (id: string) => {
    const nextModels = models.filter((m) => m !== id)
    const fallback = nextModels[0] ?? ""
    onChange({
      models: nextModels,
      chatModel: chatModel === id ? fallback : chatModel,
      agentModel: agentModel === id ? fallback : agentModel,
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              addModel()
            }
          }}
          placeholder="e.g. anthropic/claude-sonnet-4.5"
          aria-label="Add a model ID"
          spellCheck={false}
          className="font-mono text-xs"
        />
        <Button type="button" variant="outline" size="sm" onClick={addModel} disabled={!draft.trim()}>
          <Plus className="size-3.5" /> Add
        </Button>
      </div>

      {models.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          No models yet. Add at least one model ID to enable chat and the agent.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {models.map((id) => (
            <li key={id} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{id}</span>
              <RoleToggle
                active={chatModel === id}
                onClick={() => onChange({ ...value, chatModel: id })}
                icon={MessageSquare}
                label="Chat"
                title="Use as the default chat model"
              />
              <RoleToggle
                active={agentModel === id}
                onClick={() => onChange({ ...value, agentModel: id })}
                icon={Bot}
                label="Agent"
                title="Use as the agent model"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => removeModel(id)}
                aria-label={`Remove ${id}`}
                className="text-muted-foreground hover:text-destructive"
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        <MessageSquare className="mr-1 inline size-3" />
        marks the default chat model; <Bot className="mx-1 inline size-3" />
        marks the agent model. Both must be in this list.
      </p>
    </div>
  )
}

function RoleToggle({
  active,
  onClick,
  icon: Icon,
  label,
  title,
}: {
  active: boolean
  onClick: () => void
  icon: React.ComponentType<{ className?: string }>
  label: string
  title: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${label}${active ? " (selected)" : ""}`}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors",
        active
          ? "border-transparent bg-primary text-primary-foreground"
          : "border-input text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3" />
      {label}
    </button>
  )
}
