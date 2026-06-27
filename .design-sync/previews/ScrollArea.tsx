import { ScrollArea, Separator } from "codex-web-app"

const VERSES: Array<{ ref: string; text: string }> = [
  { ref: "Mark 1:1", text: "The beginning of the gospel of Jesus Christ, the Son of God." },
  { ref: "Mark 1:2", text: "As it is written in Isaiah the prophet, Behold, I send my messenger before your face." },
  { ref: "Mark 1:3", text: "The voice of one crying in the wilderness, Prepare the way of the Lord." },
  { ref: "Mark 1:4", text: "John appeared, baptizing in the wilderness and proclaiming a baptism of repentance." },
  { ref: "Mark 1:5", text: "And all the country of Judea was going out to him, and all the people of Jerusalem." },
  { ref: "Mark 1:6", text: "Now John was clothed with camel's hair and wore a leather belt around his waist." },
  { ref: "Mark 1:7", text: "And he preached, saying, After me comes he who is mightier than I." },
  { ref: "Mark 1:8", text: "I have baptized you with water, but he will baptize you with the Holy Spirit." },
  { ref: "Mark 1:9", text: "In those days Jesus came from Nazareth of Galilee and was baptized by John." },
  { ref: "Mark 1:10", text: "And when he came up out of the water, immediately he saw the heavens being torn open." },
]

export function VerseList() {
  return (
    <ScrollArea
      className="rounded-md border border-border"
      style={{ height: 240, width: 360 }}
    >
      <div style={{ padding: 12 }}>
        {VERSES.map((v, i) => (
          <div key={v.ref}>
            <div style={{ padding: "8px 4px" }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--muted-foreground)",
                  marginBottom: 2,
                }}
              >
                {v.ref}
              </div>
              <div style={{ fontSize: 13, color: "var(--foreground)", lineHeight: 1.4 }}>
                {v.text}
              </div>
            </div>
            {i < VERSES.length - 1 ? <Separator /> : null}
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
