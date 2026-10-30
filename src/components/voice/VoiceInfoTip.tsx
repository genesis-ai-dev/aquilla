import { InfoNote } from "@/components/ui/info-note"

/** Circled-i next to a field label. A click opens `content` in a small note
 *  anchored to it, and a second click shuts it (AQU-2260, Sam, Oct 29: an
 *  explanation never opens on hover). */
export function VoiceInfoTip({
  content,
  label,
}: {
  content: string
  label: string
}) {
  return (
    <InfoNote label={label} side="top" align="center" className="size-5 items-center justify-center rounded-full">
      {content}
    </InfoNote>
  )
}
