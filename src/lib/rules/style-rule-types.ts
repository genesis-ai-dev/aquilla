/**
 * Style-rule library + applicability graph — client-side contract (AQU-934).
 *
 * Canonical wire shapes for `/api/v2/projects/:id/style-rules`. The server
 * (db/shared/style-rules.ts) maps snake_case rows onto these camelCase
 * shapes, mirroring the agent-memory router. Enums here must stay in lock
 * step with the CHECK constraints in db/postgres/schema.sql.
 *
 * Scope ladder (broadest intended reach of a rule):
 *   global → genre → document → section → passage → segment
 * Applicability rows override inheritance at any narrower target; inherited
 * coverage is COMPUTED at read time, never materialized (assigned_by
 * 'inherited' exists only for deliberate audit/perf materialization).
 */
import type { RuleCheck } from "@/lib/parsers/types"

export type StyleRuleScope =
  | "global"
  | "genre"
  | "document"
  | "section"
  | "passage"
  | "segment"

export type StyleRuleStatus = "proposed" | "approved" | "rejected" | "archived"

export type StyleRuleCategory =
  | "terminology"
  | "register"
  | "formatting"
  | "grammar"
  | "orthography"
  | "style"
  | "other"

/** Citation back to the artifact a rule was extracted from. */
export type StyleRuleSource =
  | { kind: "knowledge-doc"; docId: string; nodeId?: string; quote?: string }
  | { kind: "manual" }
  | { kind: "edits" }

export interface StyleRuleExample {
  before?: string
  after?: string
  note?: string
}

export interface StyleRule {
  id: string
  /** Exactly one of orgId/projectId is set (org XOR project scope). */
  orgId: number | null
  projectId: string | null
  /** Normalized imperative rule text — what prompt injection renders. */
  instruction: string
  category: StyleRuleCategory
  scope: StyleRuleScope
  /** Free-text conditions, e.g. "only in direct speech". */
  conditions: string | null
  examples: StyleRuleExample[] | null
  exceptions: string | null
  source: StyleRuleSource | null
  /** Optional deterministic enforcement bridged into the rule engine. */
  checkSpec: RuleCheck | null
  severity: "major" | "minor"
  enabled: boolean
  status: StyleRuleStatus
  humanEdited: boolean
  provenance: Record<string, unknown> | null
  createdBy: string | null
  reviewedBy: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type ApplicabilityTargetType =
  | "genre"
  | "file"
  | "book"
  | "section"
  | "passage"
  | "segment"

export type ApplicabilityRelationship = "applies" | "likely_applies" | "excluded"

export interface RuleApplicability {
  id: string
  ruleId: string
  targetType: ApplicabilityTargetType
  /**
   * Target address by type: genre name ("poetry") | fileId | bookCode
   * ("PSA") | section label ("PSA 23") | canonicalRef range ("LUK 1:1-4") |
   * cellId.
   */
  targetId: string
  relationship: ApplicabilityRelationship
  confidence: number | null
  reason: string | null
  assignedBy: "human" | "model" | "inherited"
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

/**
 * The coordinates a cell occupies on the scope ladder — everything the
 * resolver may match applicability rows against. All fields optional except
 * segment: non-scripture cells simply have fewer coordinates.
 */
export interface CellCoordinates {
  /** cellId */
  segment: string
  /** canonicalRef ("LUK 1:1" / "LUK 1:1-2") when the cell has one. */
  passageRef?: string
  /** "BOOK CH" chapter label derived from canonicalRef. */
  section?: string
  /** USFM book code ("PSA"). */
  book?: string
  /** fileId */
  file?: string
  /** Static book-genre classification ("poetry", "gospel", …). */
  genre?: string
}

/** Candidate emitted by extraction before it is posted as a proposed rule. */
export interface StyleRuleCandidate {
  instruction: string
  category: StyleRuleCategory
  /**
   * Broadest-reach hint from the model: "global" or "<targetType>:<targetId>"
   * (e.g. "genre:poetry", "book:PSA"). Parsed into scope + an initial
   * likely_applies applicability row.
   */
  scopeHint: string
  conditions?: string
  examples?: StyleRuleExample[]
  exceptions?: string
  checkSpec?: RuleCheck
}
