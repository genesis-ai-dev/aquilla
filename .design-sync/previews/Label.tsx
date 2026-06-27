import { Label, Input, Checkbox } from "codex-web-app"

export function Default() {
  return <Label>Target language</Label>
}

export function WithInput() {
  return (
    <div style={{ width: 320, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label htmlFor="lb-lang">Target language</Label>
      <Input id="lb-lang" defaultValue="Tok Pisin" />
    </div>
  )
}

export function WithCheckbox() {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <Checkbox id="lb-cb" defaultChecked />
      <Label htmlFor="lb-cb">Show only validated verses</Label>
    </div>
  )
}

export function Disabled() {
  return (
    <div className="group" data-disabled="true" style={{ display: "flex", flexDirection: "column", gap: 6, width: 320 }}>
      <Label htmlFor="lb-dis">Consultant (locked)</Label>
      <Input id="lb-dis" defaultValue="Dr. Anna Reyes" disabled />
    </div>
  )
}
