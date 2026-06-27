import { Input, Label } from "codex-web-app"

export function Default() {
  return (
    <div style={{ width: 320, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label htmlFor="in-project">Project name</Label>
      <Input id="in-project" defaultValue="Gospel of Mark — Tok Pisin" />
    </div>
  )
}

export function Placeholder() {
  return (
    <div style={{ width: 320, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label htmlFor="in-ref">Jump to verse</Label>
      <Input id="in-ref" placeholder="e.g. MRK 4:1" />
    </div>
  )
}

export function Disabled() {
  return (
    <div style={{ width: 320, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label htmlFor="in-source">Source language</Label>
      <Input id="in-source" defaultValue="Greek (SBLGNT)" disabled />
    </div>
  )
}

export function Invalid() {
  return (
    <div style={{ width: 320, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label htmlFor="in-verse">Verse reference</Label>
      <Input id="in-verse" defaultValue="MRK 99:1" aria-invalid />
    </div>
  )
}

export function ReadOnly() {
  return (
    <div style={{ width: 320, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label htmlFor="in-id">Project ID</Label>
      <Input id="in-id" defaultValue="proj_mrk_tpi_0427" readOnly />
    </div>
  )
}
