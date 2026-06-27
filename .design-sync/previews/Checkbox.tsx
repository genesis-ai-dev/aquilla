import { Checkbox, Label } from "codex-web-app"

export function Checked() {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <Checkbox id="cb-reviewed" defaultChecked />
      <Label htmlFor="cb-reviewed">Mark MRK 4:1 as reviewed</Label>
    </div>
  )
}

export function Unchecked() {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <Checkbox id="cb-draft" />
      <Label htmlFor="cb-draft">Include unverified draft verses</Label>
    </div>
  )
}

export function Disabled() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Checkbox id="cb-locked" defaultChecked disabled />
        <Label htmlFor="cb-locked">Lock validated translation</Label>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Checkbox id="cb-off" disabled />
        <Label htmlFor="cb-off">Auto-backtranslate on commit</Label>
      </div>
    </div>
  )
}

export function Invalid() {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <Checkbox id="cb-terms" aria-invalid />
      <Label htmlFor="cb-terms">I confirm the Tok Pisin glossary is complete</Label>
    </div>
  )
}

export function VerseChecklist() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, width: 320 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Checkbox id="cl-1" defaultChecked />
        <Label htmlFor="cl-1">MRK 4:1 — drafted</Label>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Checkbox id="cl-2" defaultChecked />
        <Label htmlFor="cl-2">MRK 4:2 — peer reviewed</Label>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Checkbox id="cl-3" />
        <Label htmlFor="cl-3">MRK 4:3 — consultant approved</Label>
      </div>
    </div>
  )
}
