import { Marker, MarkerIcon, MarkerContent } from "codex-web-app"
import { CheckCircle2Icon, InfoIcon } from "lucide-react"

export function Validated() {
  return (
    <div style={{ width: 360 }}>
      <Marker>
        <MarkerIcon>
          <CheckCircle2Icon />
        </MarkerIcon>
        <MarkerContent>
          Mark 4:1 validated by consultant &middot; 2 hours ago
        </MarkerContent>
      </Marker>
    </div>
  )
}

export function DaySeparator() {
  return (
    <div style={{ width: 360 }}>
      <Marker variant="separator">
        <MarkerContent>Today</MarkerContent>
      </Marker>
    </div>
  )
}

export function Annotation() {
  return (
    <div style={{ width: 360 }}>
      <Marker variant="border">
        <MarkerIcon>
          <InfoIcon />
        </MarkerIcon>
        <MarkerContent>
          Key term &ldquo;Kingdom of God&rdquo; appears 14 times in this chapter
        </MarkerContent>
      </Marker>
    </div>
  )
}
