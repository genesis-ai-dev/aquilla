import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  Button,
  Label,
  Input,
} from "codex-web-app"

export function VerseNote() {
  return (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: 8 }}>
      <Popover defaultOpen>
        <PopoverTrigger
          render={<Button variant="outline" size="sm">Add note</Button>}
        />
        <PopoverContent side="bottom" style={{ width: 264, padding: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                Note on MRK 4:3
              </p>
              <p
                style={{
                  margin: "2px 0 0",
                  fontSize: 12,
                  color: "var(--muted-foreground)",
                }}
              >
                Visible to reviewers on this verse.
              </p>
            </div>
            <Label htmlFor="pv-note">Comment</Label>
            <Input id="pv-note" defaultValue="Check the term for ‘sower’." />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button size="sm" variant="ghost">
                Cancel
              </Button>
              <Button size="sm">Save</Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
