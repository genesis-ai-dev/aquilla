import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  Message,
  MessageAvatar,
  MessageContent,
  MessageHeader,
  Bubble,
  BubbleContent,
} from "codex-web-app"

function Turn({
  align,
  name,
  avatar,
  variant,
  children,
}: {
  align: "start" | "end"
  name: string
  avatar: string
  variant: "muted" | "default"
  children: React.ReactNode
}) {
  return (
    <Message align={align}>
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
          {avatar}
        </span>
      </MessageAvatar>
      <MessageContent>
        <MessageHeader>{name}</MessageHeader>
        <Bubble variant={variant} align={align}>
          <BubbleContent>{children}</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}

export function ChatThread() {
  return (
    <div style={{ width: 400, height: 320 }}>
      <MessageScrollerProvider>
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent style={{ padding: 12 }}>
              <MessageScrollerItem>
                <Turn align="end" name="Anna M." avatar="AM" variant="default">
                  Let&rsquo;s draft Mark 4:1 into Tok Pisin.
                </Turn>
              </MessageScrollerItem>
              <MessageScrollerItem>
                <Turn align="start" name="Aquilla assistant" avatar="AI" variant="muted">
                  Jesus teaches a great crowd from a boat by the sea.
                </Turn>
              </MessageScrollerItem>
              <MessageScrollerItem>
                <Turn align="end" name="Anna M." avatar="AM" variant="default">
                  Keep &ldquo;tok piksa&rdquo; for parable, please.
                </Turn>
              </MessageScrollerItem>
              <MessageScrollerItem scrollAnchor>
                <Turn align="start" name="Aquilla assistant" avatar="AI" variant="muted">
                  Done &mdash; drafted and flagged two key terms for review.
                </Turn>
              </MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  )
}
