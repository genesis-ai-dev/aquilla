import { BubbleGroup, Bubble, BubbleContent, BubbleReactions } from "codex-web-app"

export function Conversation() {
  return (
    <BubbleGroup style={{ width: 360 }}>
      <Bubble variant="muted" align="start">
        <BubbleContent>
          How should I render &ldquo;parable&rdquo; in Mark 4:1 for Tok Pisin?
        </BubbleContent>
      </Bubble>
      <Bubble variant="default" align="end">
        <BubbleContent>
          Use &ldquo;tok piksa&rdquo; &mdash; it carries the figurative
          comparison the Greek παραβολή implies, and matches your glossary entry.
        </BubbleContent>
      </Bubble>
      <Bubble variant="muted" align="start">
        <BubbleContent>Perfect, drafting the verse now.</BubbleContent>
      </Bubble>
    </BubbleGroup>
  )
}

export function Variants() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, width: 320 }}>
      <Bubble variant="default" align="end">
        <BubbleContent>Translation saved to Mark 4:1</BubbleContent>
      </Bubble>
      <Bubble variant="tinted" align="start">
        <BubbleContent>Suggested gloss from translation memory</BubbleContent>
      </Bubble>
      <Bubble variant="outline" align="start">
        <BubbleContent>Reviewer note pending consultant approval</BubbleContent>
      </Bubble>
      <Bubble variant="destructive" align="start">
        <BubbleContent>Key term &ldquo;Kingdom&rdquo; is untranslated</BubbleContent>
      </Bubble>
    </div>
  )
}

export function WithReactions() {
  return (
    <div style={{ width: 320, paddingBottom: 14 }}>
      <Bubble variant="default" align="end">
        <BubbleContent>
          Drafted Mark 4:1&ndash;2 in Tok Pisin and flagged two key terms for
          your review.
        </BubbleContent>
        <BubbleReactions side="bottom" align="end">
          👍 3
        </BubbleReactions>
      </Bubble>
    </div>
  )
}
