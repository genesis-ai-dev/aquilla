import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/** Compact language tag on a voice name when the project has multiple lanes. */
export function VoiceLanguageBadge({
  language,
  className,
}: {
  language: string
  className?: string
}) {
  const label = language.trim()
  if (!label) return null
  return (
    <Badge variant="soft" className={cn("h-4 px-1 font-mono text-[10px] leading-none", className)}>
      {label}
    </Badge>
  )
}

export function VoiceNameWithLanguage({
  name,
  language,
  showBadge,
  className,
}: {
  name: string
  language?: string
  showBadge: boolean
  className?: string
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span className="truncate">{name}</span>
      {showBadge && language ? <VoiceLanguageBadge language={language} /> : null}
    </span>
  )
}
