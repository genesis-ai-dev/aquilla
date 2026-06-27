import { Separator } from "codex-web-app"

export function Horizontal() {
  return (
    <div style={{ width: 300 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--foreground)" }}>
        Gospel of Mark
      </div>
      <div style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
        Tok Pisin · 16 chapters
      </div>
      <Separator className="my-3" />
      <div style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
        421 of 678 verses reviewed
      </div>
    </div>
  )
}

export function Vertical() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        height: 28,
        fontSize: 13,
        color: "var(--foreground)",
      }}
    >
      <span>Source: SBLGNT</span>
      <Separator orientation="vertical" />
      <span>Draft</span>
      <Separator orientation="vertical" />
      <span>3 contributors</span>
    </div>
  )
}
