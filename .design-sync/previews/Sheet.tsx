import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
  Label,
  Input,
  Button,
} from "codex-web-app"

export function ProjectSettings() {
  return (
    <Sheet open modal={false}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Project settings</SheetTitle>
          <SheetDescription>Gospel of Mark · Tok Pisin</SheetDescription>
        </SheetHeader>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 14,
            padding: 16,
            flex: 1,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Label htmlFor="sh-name">Project name</Label>
            <Input id="sh-name" defaultValue="Gospel of Mark" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Label htmlFor="sh-lang">Target language</Label>
            <Input id="sh-lang" defaultValue="Tok Pisin (tpi)" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Label htmlFor="sh-src">Source text</Label>
            <Input id="sh-src" defaultValue="eBible · Greek SBLGNT" />
          </div>
        </div>
        <SheetFooter>
          <Button style={{ width: "100%" }}>Save changes</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
