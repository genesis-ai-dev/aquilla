import { Spinner } from "codex-web-app"

export function WithLabel() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Spinner className="size-5 text-primary" />
      <span style={{ fontSize: 14, color: "var(--muted-foreground)" }}>
        Loading translations…
      </span>
    </div>
  )
}

export function Sizes() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
      <Spinner className="size-4 text-muted-foreground" />
      <Spinner className="size-6 text-foreground" />
      <Spinner className="size-8 text-primary" />
    </div>
  )
}

export function InlineButton() {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        background: "var(--primary)",
        color: "var(--primary-foreground)",
        borderRadius: 8,
        padding: "8px 14px",
        fontSize: 14,
        fontWeight: 500,
      }}
    >
      <Spinner className="size-4" />
      Generating back-translation
    </div>
  )
}
