import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import {
  buildProjectSettingsHandoffUrl,
  workspaceReturnPath,
} from "@/lib/ad11/navigation"

interface Props {
  projectId: string
  systemPrompt: string | undefined
  sourceLanguage: string
  targetLanguage: string
}

function resolvePrompt(template: string, src: string, tgt: string): string {
  return template
    .replace(/\{sourceLanguage\}/g, src)
    .replace(/\{targetLanguage\}/g, tgt)
}

export function InstructionsSection({
  projectId, systemPrompt, sourceLanguage, targetLanguage,
}: Props) {
  const resolved = resolvePrompt(systemPrompt || DEFAULT_SYSTEM_PROMPT, sourceLanguage, targetLanguage)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Instructions</CardTitle>
        <p className="text-sm text-muted-foreground">
          What Codex has been told about your project.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-sm font-sans">
          {resolved}
        </pre>
        <a
          href={buildProjectSettingsHandoffUrl({
            projectId,
            section: "ai",
            returnTo: workspaceReturnPath(projectId),
          })}
          className="text-sm text-primary hover:underline"
        >
          Edit in Project Settings →
        </a>
      </CardContent>
    </Card>
  )
}
