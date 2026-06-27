import { Badge } from "codex-web-app"

export function Variants() {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <Badge variant="default">68%</Badge>
      <Badge variant="secondary">Draft</Badge>
      <Badge variant="destructive">Blocked</Badge>
      <Badge variant="outline">Greek SBLGNT</Badge>
    </div>
  )
}

export function ReviewStatus() {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <Badge variant="default">Validated</Badge>
      <Badge variant="secondary">In review</Badge>
      <Badge variant="outline">Awaiting back-translation</Badge>
      <Badge variant="destructive">Needs work</Badge>
    </div>
  )
}

export function Languages() {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <Badge variant="secondary">Tok Pisin</Badge>
      <Badge variant="secondary">Hebrew</Badge>
      <Badge variant="secondary">Koine Greek</Badge>
      <Badge variant="outline">+4 more</Badge>
    </div>
  )
}
