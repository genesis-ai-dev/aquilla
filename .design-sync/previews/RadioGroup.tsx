import { RadioGroup, RadioGroupItem, Label } from "codex-web-app"

export function VerseStatus() {
  return (
    <RadioGroup defaultValue="reviewed" style={{ width: 320 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <RadioGroupItem id="vs-draft" value="draft" />
        <Label htmlFor="vs-draft">Draft</Label>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <RadioGroupItem id="vs-reviewed" value="reviewed" />
        <Label htmlFor="vs-reviewed">Peer reviewed</Label>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <RadioGroupItem id="vs-validated" value="validated" />
        <Label htmlFor="vs-validated">Consultant validated</Label>
      </div>
    </RadioGroup>
  )
}

export function SourcePicker() {
  return (
    <RadioGroup defaultValue="sblgnt" style={{ width: 320 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <RadioGroupItem id="sp-sblgnt" value="sblgnt" />
        <Label htmlFor="sp-sblgnt">Greek SBLGNT</Label>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <RadioGroupItem id="sp-ult" value="ult" />
        <Label htmlFor="sp-ult">English ULT</Label>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <RadioGroupItem id="sp-hebrew" value="hebrew" disabled />
        <Label htmlFor="sp-hebrew">Hebrew WLC (NT only)</Label>
      </div>
    </RadioGroup>
  )
}
