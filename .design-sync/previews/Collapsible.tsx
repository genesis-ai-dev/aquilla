import { Collapsible, CollapsibleTrigger, CollapsibleContent, Badge } from "codex-web-app"

export function VerseNotes() {
  return (
    <Collapsible open onOpenChange={() => {}} className="w-80">
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-input px-3 py-2 text-sm font-medium text-foreground">
        <span>Translator notes · Mark 1:4</span>
        <Badge variant="secondary">3</Badge>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        <p style={{ margin: 0 }}>
          "Baptism of repentance" — confirm Tok Pisin renders the call to turn
          from sin, not merely the washing ritual.
        </p>
        <p style={{ margin: 0 }}>
          Consultant flagged for alignment with Isaiah 40:3 quotation.
        </p>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function Closed() {
  return (
    <Collapsible open={false} onOpenChange={() => {}} className="w-80">
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-input px-3 py-2 text-sm font-medium text-foreground">
        <span>Revision history · Genesis 1:1</span>
        <span style={{ color: "var(--muted-foreground)", fontSize: 12 }}>5 edits</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        Hidden until expanded.
      </CollapsibleContent>
    </Collapsible>
  )
}
