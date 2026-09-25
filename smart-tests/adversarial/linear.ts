import { marker } from "./fingerprint"

/** One verified product failure, as the reporter hands it over. */
export interface Finding {
  fingerprint: string
  attackId: string
  mode: string
  journey: string
  reason: string
  failedChecks: string[]
  diffs: string[]
  unmet: string[]
  goal: string
  secondGoal: string | null
  mutator: string | null
  fuzzSeed: number | null
  runId: string
  target: string
  deployedSha: string | null
  evidencePath: string
  projectIds: string[]
}

export interface RunSummary {
  runId: string
  target: string
  deployedSha: string | null
  harnessAvailable: boolean
  harnessReason: string
  counts: Record<string, number>
  inconclusive: { attackId: string; reason: string }[]
  navigability: string[]
  tickets: string[]
  evidencePath: string
}

export const ticketTitle = (finding: Finding) =>
  `Adversarial: ${finding.attackId} — ${finding.failedChecks[0] ?? "outcome"} failed`

export function ticketBody(finding: Finding): string {
  return [
    `The adversarial Jev suite found a verified product failure on **${finding.target}**`
      + (finding.deployedSha ? ` at build \`${finding.deployedSha}\`.` : "."),
    "",
    `**Attack:** \`${finding.attackId}\` (${finding.mode}, ${finding.journey} journey)`,
    finding.mutator ? `**Condition:** \`${finding.mutator}\`` : null,
    finding.fuzzSeed !== null ? `**Fuzz seed:** ${finding.fuzzSeed}` : null,
    "",
    "**Goal given to Jev:**",
    `> ${finding.goal}`,
    finding.secondGoal ? `\n**Second agent's goal:**\n> ${finding.secondGoal}` : null,
    "",
    `**Result:** ${finding.reason}`,
    finding.unmet.length ? `**Unmet requirements:** ${finding.unmet.join(", ")}` : null,
    finding.diffs.length ? `**Unexpected changes:**\n${finding.diffs.map((d) => `- ${d}`).join("\n")}` : null,
    "",
    `**Evidence:** \`${finding.evidencePath}\` (run \`${finding.runId}\`). The fixture projects were kept: ${finding.projectIds.map((id) => `\`${id}\``).join(", ")}.`,
    "",
    "Before promoting, confirm the agent did not simply act on the wrong row: the oracle cannot tell a product fault from an agent mistake when both leave the same state.",
    "",
    marker(finding.fingerprint),
  ].filter((line) => line !== null).join("\n")
}

export function rollupBody(summary: RunSummary): string {
  const header = summary.harnessAvailable
    ? `Adversarial Jev run \`${summary.runId}\` on **${summary.target}**`
    : `**HARNESS UNAVAILABLE** — adversarial run \`${summary.runId}\` on **${summary.target}** produced no trustworthy coverage.`
  return [
    header + (summary.deployedSha ? ` (build \`${summary.deployedSha}\`)` : ""),
    "",
    summary.harnessAvailable ? null : `${summary.harnessReason} No tickets were filed. Start with the runner and target, not the build.`,
    "| Verdict | Count |",
    "| --- | --- |",
    ...Object.entries(summary.counts).map(([verdict, count]) => `| ${verdict} | ${count} |`),
    "",
    summary.tickets.length ? `Tickets: ${summary.tickets.join(", ")}` : "No new or updated tickets.",
    summary.navigability.length ? `Navigability misses (inconclusive fuzz goals): ${summary.navigability.join(", ")}` : null,
    summary.inconclusive.length
      ? `Inconclusive:\n${summary.inconclusive.map((entry) => `- \`${entry.attackId}\`: ${entry.reason}`).join("\n")}` : null,
    "",
    `Evidence: \`${summary.evidencePath}\``,
  ].filter((line) => line !== null).join("\n")
}

type Fetch = typeof fetch

interface Resolved { teamId: string; triageId: string; bugLabelId: string | null; projectId: string | null; parentId: string; rollupId: string }

/** Minimal Linear GraphQL client. Everything it needs is resolved by name at run time. */
export class LinearClient {
  private resolved: Promise<Resolved> | null = null
  private readonly apiKey: string
  private readonly fetchImpl: Fetch
  private readonly parent: string
  private readonly rollup: string

  constructor(apiKey: string, fetchImpl: Fetch = fetch, parent = "AQU-1330", rollup = "AQU-1338") {
    this.apiKey = apiKey
    this.fetchImpl = fetchImpl
    this.parent = parent
    this.rollup = rollup
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
    })
    const body = await response.json() as { data?: T; errors?: { message: string }[] }
    if (!response.ok || body.errors?.length || !body.data) {
      throw new Error(`Linear request failed: ${body.errors?.[0]?.message ?? response.status}`)
    }
    return body.data
  }

  private resolve(): Promise<Resolved> {
    this.resolved ??= this.request<{
      parent: { id: string; team: { id: string; states: { nodes: { id: string; name: string }[] } } }
      rollup: { id: string }
      issueLabels: { nodes: { id: string; team: { id: string } | null }[] }
      projects: { nodes: { id: string }[] }
    }>(`query($p: String!, $r: String!) {
      parent: issue(id: $p) { id team { id states { nodes { id name } } } }
      rollup: issue(id: $r) { id }
      issueLabels(filter: { name: { eq: "Bug" } }) { nodes { id team { id } } }
      projects(filter: { name: { eq: "Prototype Debugging" } }) { nodes { id } }
    }`, { p: this.parent, r: this.rollup }).then((data) => {
      const triage = data.parent.team.states.nodes.find((state) => state.name === "Triage")
      // Automation never files into Todo: humans promote from Triage.
      if (!triage) throw new Error("Linear team has no Triage state")
      const labels = data.issueLabels.nodes
      return {
        teamId: data.parent.team.id,
        triageId: triage.id,
        bugLabelId: (labels.find((l) => l.team?.id === data.parent.team.id) ?? labels.find((l) => !l.team))?.id ?? null,
        projectId: data.projects.nodes[0]?.id ?? null,
        parentId: data.parent.id,
        rollupId: data.rollup.id,
      }
    })
    return this.resolved
  }

  /** Comment on an open ticket with the same fingerprint, or create one in Triage. Returns its identifier. */
  async fileFinding(finding: Finding): Promise<string> {
    const found = await this.request<{ issues: { nodes: { id: string; identifier: string }[] } }>(
      `query($m: String!) { issues(first: 1, filter: {
        description: { contains: $m }, state: { type: { nin: ["completed", "canceled"] } } }) { nodes { id identifier } } }`,
      { m: marker(finding.fingerprint) })
    const existing = found.issues.nodes[0]
    if (existing) {
      await this.comment(existing.id, `Seen again in run \`${finding.runId}\``
        + (finding.deployedSha ? ` on build \`${finding.deployedSha}\`` : "") + `. Evidence: \`${finding.evidencePath}\`.`)
      return existing.identifier
    }
    const ids = await this.resolve()
    const created = await this.request<{ issueCreate: { issue: { identifier: string } } }>(
      `mutation($i: IssueCreateInput!) { issueCreate(input: $i) { issue { identifier } } }`,
      { i: {
        teamId: ids.teamId, stateId: ids.triageId, parentId: ids.parentId,
        ...(ids.projectId ? { projectId: ids.projectId } : {}),
        ...(ids.bugLabelId ? { labelIds: [ids.bugLabelId] } : {}),
        title: ticketTitle(finding), description: ticketBody(finding),
      } })
    return created.issueCreate.issue.identifier
  }

  async postRollup(summary: RunSummary): Promise<void> {
    await this.comment((await this.resolve()).rollupId, rollupBody(summary))
  }

  private async comment(issueId: string, body: string): Promise<void> {
    await this.request(`mutation($i: CommentCreateInput!) { commentCreate(input: $i) { success } }`,
      { i: { issueId, body } })
  }
}
