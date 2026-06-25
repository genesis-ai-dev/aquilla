import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
  Button,
  Badge,
} from "codex-web-app"

export function ProjectCard() {
  return (
    <Card style={{ width: 360 }}>
      <CardHeader>
        <CardTitle>Gospel of Mark</CardTitle>
        <CardDescription>Tok Pisin · 16 chapters · drafting</CardDescription>
        <CardAction>
          <Badge variant="secondary">68%</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p style={{ fontSize: 14, color: "var(--muted-foreground)", margin: 0 }}>
          421 of 678 verses translated and reviewed. Three contributors are
          active on this project this week.
        </p>
      </CardContent>
      <CardFooter style={{ gap: 8 }}>
        <Button size="sm">Open</Button>
        <Button size="sm" variant="outline">
          Share
        </Button>
      </CardFooter>
    </Card>
  )
}

export function Simple() {
  return (
    <Card style={{ width: 320 }}>
      <CardHeader>
        <CardTitle>Translation memory</CardTitle>
        <CardDescription>Suggestions from validated drafts</CardDescription>
      </CardHeader>
      <CardContent>
        <p style={{ fontSize: 14, margin: 0 }}>
          1,204 segments indexed across 6 source documents.
        </p>
      </CardContent>
    </Card>
  )
}
