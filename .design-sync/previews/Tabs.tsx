import { Tabs, TabsList, TabsTrigger, TabsContent } from "codex-web-app"

export function CellPanel() {
  return (
    <Tabs value="translation" onValueChange={() => {}} className="w-80">
      <TabsList>
        <TabsTrigger value="translation">Translation</TabsTrigger>
        <TabsTrigger value="backtranslation">Back-translation</TabsTrigger>
        <TabsTrigger value="notes" attentionDot="amber">
          Notes
        </TabsTrigger>
      </TabsList>
      <TabsContent value="translation" className="mt-3 text-sm text-foreground">
        Jon i kam, na em i baptaisim ol manmeri long ples i no gat man.
      </TabsContent>
    </Tabs>
  )
}

export function BackTranslationActive() {
  return (
    <Tabs value="backtranslation" onValueChange={() => {}} className="w-80">
      <TabsList>
        <TabsTrigger value="translation">Translation</TabsTrigger>
        <TabsTrigger value="backtranslation">Back-translation</TabsTrigger>
        <TabsTrigger value="notes">Notes</TabsTrigger>
      </TabsList>
      <TabsContent value="backtranslation" className="mt-3 text-sm text-muted-foreground">
        "John came, and he baptized the people in the wilderness." — auto-generated,
        awaiting consultant review.
      </TabsContent>
    </Tabs>
  )
}
