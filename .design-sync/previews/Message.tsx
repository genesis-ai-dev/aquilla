import {
  MessageGroup,
  Message,
  MessageAvatar,
  MessageContent,
  MessageHeader,
  MessageFooter,
  Bubble,
  BubbleContent,
} from "codex-web-app"
import { SparklesIcon } from "lucide-react"

export function AssistantMessage() {
  return (
    <Message align="start" style={{ width: 380 }}>
      <MessageAvatar>
        <span
          style={{
            display: "flex",
            width: 32,
            height: 32,
            alignItems: "center",
            justifyContent: "center",
            color: "var(--muted-foreground)",
          }}
        >
          <SparklesIcon size={16} />
        </span>
      </MessageAvatar>
      <MessageContent>
        <MessageHeader>Aquilla assistant</MessageHeader>
        <Bubble variant="muted">
          <BubbleContent>
            In Mark 4:1 Jesus begins teaching from a boat. For Tok Pisin, I&rsquo;d
            keep &ldquo;arapela bikpela lain&rdquo; for the large crowd.
          </BubbleContent>
        </Bubble>
        <MessageFooter>Drafted just now</MessageFooter>
      </MessageContent>
    </Message>
  )
}

export function TranslatorMessage() {
  return (
    <Message align="end" style={{ width: 380 }}>
      <MessageAvatar>
        <span
          style={{
            display: "flex",
            width: 32,
            height: 32,
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          AM
        </span>
      </MessageAvatar>
      <MessageContent>
        <MessageHeader>Anna M.</MessageHeader>
        <Bubble variant="default" align="end">
          <BubbleContent>
            Good. Can you also check the gloss for &ldquo;parable&rdquo; in verse 2?
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}

export function Thread() {
  return (
    <MessageGroup style={{ width: 380 }}>
      <Message align="start">
        <MessageAvatar>
          <span
            style={{
              display: "flex",
              width: 32,
              height: 32,
              alignItems: "center",
              justifyContent: "center",
              color: "var(--muted-foreground)",
            }}
          >
            <SparklesIcon size={16} />
          </span>
        </MessageAvatar>
        <MessageContent>
          <MessageHeader>Aquilla assistant</MessageHeader>
          <Bubble variant="muted">
            <BubbleContent>I&rsquo;ve drafted Mark 4:1 in Tok Pisin.</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
      <Message align="end">
        <MessageAvatar>
          <span
            style={{
              display: "flex",
              width: 32,
              height: 32,
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            AM
          </span>
        </MessageAvatar>
        <MessageContent>
          <MessageHeader>Anna M.</MessageHeader>
          <Bubble variant="default" align="end">
            <BubbleContent>Looks great &mdash; approving the verse.</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    </MessageGroup>
  )
}
