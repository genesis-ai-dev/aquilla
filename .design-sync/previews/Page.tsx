import {
  PageHeader,
  Section,
  StatTile,
  EmptyState,
  Badge,
  Button,
} from "codex-web-app"

export function Dashboard() {
  return (
    <div style={{ width: 720 }}>
      <PageHeader
        title="Gospel of Mark"
        description="Tok Pisin translation · 16 chapters · drafting"
        actions={<Button size="sm">Open editor</Button>}
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <StatTile label="Verses" value="678" />
        <StatTile label="Reviewed" value="421" hint="62% complete" />
        <StatTile label="Contributors" value="3" />
      </div>
      <Section
        title="Recent activity"
        description="Validation and drafting across the team"
        action={<Badge variant="secondary">Live</Badge>}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--foreground)" }}>Anna validated Mark 1:1–8</span>
            <span style={{ color: "var(--muted-foreground)" }}>2h ago</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--foreground)" }}>Randall drafted Mark 2:1–12</span>
            <span style={{ color: "var(--muted-foreground)" }}>5h ago</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--foreground)" }}>Back-translation refreshed</span>
            <span style={{ color: "var(--muted-foreground)" }}>yesterday</span>
          </div>
        </div>
      </Section>
    </div>
  )
}

export function Sections() {
  return (
    <div style={{ width: 480, display: "flex", flexDirection: "column", gap: 16 }}>
      <Section
        title="Source text"
        description="Greek SBLGNT"
        footer={<Button size="sm" variant="outline">Change source</Button>}
      >
        <p style={{ margin: 0, fontSize: 14, color: "var(--muted-foreground)" }}>
          Aligned to the target at the verse level. 678 segments indexed.
        </p>
      </Section>
      <Section title="Quality checks">
        <div style={{ display: "flex", gap: 8 }}>
          <Badge variant="default">12 passed</Badge>
          <Badge variant="destructive">2 flagged</Badge>
        </div>
      </Section>
    </div>
  )
}

export function NoProjects() {
  return (
    <div style={{ width: 480 }}>
      <EmptyState
        title="No projects yet"
        description="Create your first translation project or import a Paratext project to get started."
        action={<Button size="sm">New project</Button>}
      />
    </div>
  )
}
