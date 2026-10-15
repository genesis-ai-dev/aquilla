# Specification: Ambient Localization and Live Content Pipelines

> Source document for this repository, as written by Ryder (2026-10-15). Kept
> verbatim apart from Markdown formatting. Implementation status against each
> section lives in [RESEARCH-PLAN.md](RESEARCH-PLAN.md) and [GATE-A.md](GATE-A.md).

**Origin.** Is there a grok-bot / muse / dot-like version of Aquilla where all
the context is under the hood and you generate the UI you need live — and the
real value is the integrations: it lives in all your normal tools and ensures
everything gets translated using your org standards and full context (with a
minimal, approachable app interface)? And: imagine a folder where you drop
files, and then you can open them in any language…

**Status:** Proposed architecture and product hypothesis
**Initial proving ground:** Live IDML round-tripping for an existing paid research engagement
**Long-term vision:** Multilingual content that stays synchronized with its sources, organizational decisions, and publishing environments—without requiring a traditional TMS workflow.

## 1. Executive thesis

Aquilla should investigate a simpler architecture in which translation is a continuously maintained transformation of existing content, rather than a separate collection of translation projects and imported segment records.

The fundamental model is:

```
Source + Context + Decisions ⟶ Localized Artifacts
```

Source systems retain ownership of their content. Aquilla maintains the translation-specific decisions, dependencies, transformation history, and validation evidence necessary to produce and maintain localized versions.

Users interact through existing folders, repositories, publishing systems, email, or agent conversations. A specialized application remains available for detailed review and intervention, but is no longer mandatory.

The key product promise: **Translate once, stay translated. Correct once, propagate intelligently.**

## 2. The disruptive innovation hypothesis

This is potentially disruptive because it competes on a different basis from traditional translation management software.

| Traditional TMS | Ambient localization |
|---|---|
| Enter the application | Remain in existing tools |
| Import content | Observe connected content |
| Create translation projects | Define desired multilingual outcomes |
| Manage segments | Maintain content dependencies |
| Export completed translations | Continuously update native artifacts |
| Correct individual outputs | Propagate approved decisions |
| Pay for translation workflows | Pay for maintained multilingual capability |

The initial target is not necessarily an enterprise localization department. It is an organization that needs recurring multilingual output but cannot justify the administrative overhead of a translation operation.

The disruptive entry point is convenience and accessibility, not superior enterprise functionality.

The upmarket trajectory comes from adding assurance, permissions, approval policies, auditability, and complex integrations as customers' needs grow.

This thesis fails if existing platforms absorb the capability before Aquilla establishes a valuable independent role, or if customers will not pay for ongoing synchronization.

## 3. Product principles

- **External content ownership.** Aquilla does not become the canonical repository for customer documents.
- **Functional core.** Extraction, identity reconciliation, transformation planning, patch application, and validation should be independently testable functions wherever possible.
- **Minimal durable state.** Store facts, decisions, approvals, lineage, and necessary synchronization metadata. Derive everything else.
- **Native artifact preservation.** Preserve structure and formatting rather than rebuilding files in an Aquilla-specific representation.
- **Bidirectional feedback.** Target-language edits can inform future translation and trigger review of related content.
- **Safe convergence.** Repeated, reordered, or concurrent events should converge wherever the operation's semantics permit.
- **Human authority.** Model-generated changes must not silently override approved human decisions.
- **Invisible by default, inspectable on demand.** Users can request a UI to understand, audit, or modify any operation.
- **Multimodal by design.** Text is the first implementation, not the boundary of the architecture.
- **Integration simplicity.** Connecting a content source should require as little configuration as possible.

## 4. Proposed functional architecture

```
External source systems      IDML · Folders · Git · CMS · Media
Adapters + identity recon.   Extract · Anchor · Diff · Patch
Localization engine          Context · Translate · Validate · Render
Durable facts and decisions  Revisions · Approvals · Overrides · Provenance
Interaction surfaces         Agent · Email · Folder · API · Generated UI
```

### 4.1 Adapter contract

```ts
interface ContentAdapter<T> {
  extract(source: T): ContentGraph;
  reconcile(previous: ContentGraph, current: ContentGraph): IdentityMapping;
  apply(source: T, patches: ContentPatch[]): PatchResult<T>;
  validate(output: T): ValidationResult;
}
```

Adapters must preserve native references and report unsupported operations explicitly.

### 4.2 Identity and CRDT-inspired reconciliation

Content hashes alone are insufficient because editing content changes its hash without necessarily changing its identity.

For structured formats, use native identifiers where reliable. For less-structured formats, use CRDT-inspired techniques:

- Stable logical anchors and relative positions.
- Operation-based edits rather than whole-document replacement.
- Causal metadata, including revision ancestry.
- Idempotent operation identifiers.
- Deterministic ordering of concurrent operations.
- Tombstones or equivalent lineage for deletions.
- Explicit conflict detection for incompatible semantic changes.

A possible content-unit representation:

```ts
type ContentUnit = {
  logicalId: string;
  nativeAnchor?: string;
  structuralPath: string;
  contentHash: string;
  sourceRevision: string;
  predecessorIds?: string[];
};
```

An identity reconciliation operation should classify units as unchanged, modified, inserted, deleted, moved, split, merged, or ambiguous.

Important limitation: CRDT principles can make edit application convergent, but cannot guarantee that independently edited translations remain semantically equivalent.

For example, two concurrent edits can merge without data loss while producing a sentence that makes no sense. Semantic conflicts must be detected and escalated separately.

Nor can arbitrary external file edits be treated as CRDT operations unless their identities and causal relationships can be reconstructed reliably. Ambiguous matching must remain an explicit state rather than being silently guessed.

### 4.3 Translation as a map operation

The translation engine receives explicit inputs and produces an immutable proposed result.

```ts
type TranslationRequest = {
  unitId: string;
  sourceHash: string;
  sourceLocale: string;
  targetLocale: string;
  contextRevision: string;
  policyRevision: string;
};
type TranslationResult = {
  request: TranslationRequest;
  translatedContent: string;
  modelProvenance: string;
  validationEvidence: ValidationResult[];
};
```

A translation can be modeled as a function of these inputs, but LLM inference is not necessarily deterministic. Reproducibility therefore requires retaining the actual output and sufficient provenance, not merely the model name and input hashes.

The system must also handle cross-unit context dependencies: a changed character description or terminology decision may invalidate translations whose source text is unchanged.

### 4.4 Patch application

Patches should carry preconditions and authority metadata.

```ts
type ContentPatch = {
  operationId: string;
  logicalId: string;
  expectedRevision: string;
  targetLocale: string;
  operation: "replace" | "insert" | "delete";
  content?: string;
  authority: "agent" | "human" | "approved";
};
```

The patch engine must reject stale or unauthorized operations, preserve native structure, and record conflicts.

A human-approved translation must not be overwritten by a later model output merely because that output has a newer timestamp.

## 5. Initial vertical slice: live IDML round-tripping

The first implementation should prove the architecture through a difficult but commercially meaningful workflow.

**Required workflow**

- Connect or supply a source IDML package.
- Extract text and stable structural references.
- Produce a target-language IDML package.
- Open and render the translated document using a compatible production tool.
- Modify the source document.
- Reconcile source identities and identify affected content.
- Update only necessary target content and layout.
- Preserve unaffected target edits and formatting.
- Detect overset text, missing content, font problems, and layout regressions.
- Produce a reviewable change report.

The system should treat layout repair as a constrained optimization problem, not a free-form redesign.

Possible repair actions include adjusting text-frame geometry, typography within approved limits, line breaks, and permitted image or layout relationships.

A visually plausible preview is not sufficient. The final IDML must remain editable and valid in the customer's actual InDesign workflow.

**Deliberate exclusions from the first version.** No general-purpose workflow builder, no replacement document editor, no universal connector marketplace, no autonomous redesign of arbitrary publications, and no requirement to migrate existing Aquilla projects.

The research should establish the smallest reliable IDML round trip before expanding scope.

## 6. Success criteria

Three independent gates: technical feasibility, customer value, and disruptive-market potential. The thresholds below are proposed acceptance targets, not observed performance.

### Gate A: Technical success

| Metric | Proposed acceptance criterion |
|---|---|
| Native format integrity | 100% of test outputs open successfully in the target InDesign version |
| Text preservation | No missing, duplicated, or incorrectly ordered content in the test corpus |
| Unchanged-content stability | 100% of unchanged, unaffected units retain their approved translations |
| Incremental updates | At least 95% of straightforward edits avoid retranslating unaffected units |
| Patch idempotency | Reapplying an operation produces no additional changes |
| Event ordering | All supported concurrent-operation permutations converge to the same structural result |
| Conflict safety | 100% of deliberately constructed ambiguous/conflicting cases are detected rather than silently overwritten |
| Round-trip fidelity | Unrelated styles, links, assets, and document structure remain intact |
| Recovery | Every published change can be traced and rolled back |
| Rendering | All overflow and missing-content defects in the test corpus are detected |

The rendering criterion is intentionally narrower than "all layout problems." Visual quality is partly subjective, so the acceptance corpus should also include human evaluation of layout fidelity.

For concurrency testing, use property-based tests that generate insertions, deletions, moves, splits, merges, and concurrent edits, then compare results across operation permutations.

### Gate B: Customer success

| Measure | Target |
|---|---|
| Setup time | ≤ 15 min for a supported self-service connection |
| Routine update time | ≥ 80% less human handling time versus existing workflow |
| First output | ≤ 10 min for a small supported document, excluding required review |
| Repeat use | ≥ 70% of pilot organizations independently run a second real workflow |

The first two are more important than translation throughput. The disruptive promise is the removal of coordination work.

For the paid IDML engagement, the primary commercial measure should be how much manual production and rework the customer can eliminate without sacrificing publication quality.

### Gate C: Disruptive-market validation

The technology working is not sufficient. Test the following with at least five organizations beyond the initial customer.

| Hypothesis | Evidence required |
|---|---|
| Nonconsumers can adopt | Organizations without a TMS successfully use the system without translation-management training |
| Integration is the primary value | Customers choose connected workflows over manual upload/download even when translation quality is equivalent |
| Recurring demand exists | Customers continue using it across multiple publication cycles |
| Context compounds | Previously approved decisions measurably reduce repeated corrections |
| Willingness to pay exists | At least three organizations commit to paid continued use or a paid pilot |
| Upmarket expansion is plausible | Increasing content volume creates demand for assurance and governance rather than abandonment |

Failure to secure repeat usage or payment is more consequential than failure to implement a particular integration.

## 7. Implementation plan

- **Phase 1 — Prove the functional core.** Standalone IDML adapter, content graph, identity reconciliation, deterministic patch engine. Test without any AI or Aquilla-specific dependencies. *Exit:* native files survive extraction and no-op round-tripping without unintended changes.
- **Phase 2 — Prove incremental multilingual updates.** Translation mapping, immutable output records, source-change detection, preservation of human overrides. *Exit:* a source edit updates the relevant target content without destroying unrelated work.
- **Phase 3 — Prove layout assurance.** InDesign-compatible rendering, visual comparison, overflow detection, narrowly constrained agentic layout repair. *Exit:* an editable publication and a trustworthy exception report.
- **Phase 4 — Prove ambient operation.** Watched folder or remote drive; source changes trigger updates automatically; agent interface for inspection and correction. *Exit:* a customer completes a real publication update without operating a TMS.
- **Phase 5 — Prove generality.** A second, structurally different adapter (Git-managed Markdown or CMS content) on the same core. *Exit:* the second adapter does not require redesigning the synchronization and decision architecture.

Phase 5 is particularly important. If every format requires a bespoke synchronization engine, the proposed platform abstraction has failed.

## 8. What to reuse from Aquilla

| Existing capability | Recommendation |
|---|---|
| Organizational context and decisions | Reuse concepts and proven storage where appropriate |
| Translation models and orchestration | Reuse behind a small transformation interface |
| Mods | Explore as optional interaction surfaces |
| Existing editor | Retain as an advanced review surface |
| Imported segment database | Do not make it a required dependency |
| Project and workflow hierarchy | Make optional or derive from source relationships |
| Permissions and audit trails | Preserve essential authority semantics |
| Agent API | Adapt to content operations and event-driven workflows |

The goal is not necessarily to replace Aquilla immediately. It is to prove a simpler core that could eventually power Aquilla—or stand independently if that proves better.

## 9. Stop conditions

Reconsider the architecture if:

- Reliable round-tripping requires reconstructing substantial portions of InDesign's internal document model.
- Identity reconciliation repeatedly produces ambiguous matches that require extensive human intervention.
- Incremental processing costs more than full regeneration for typical documents.
- Human review and layout repair consume most of the time supposedly saved.
- The second adapter requires format-specific changes throughout the core.
- Customers prefer their existing production workflow despite a working prototype.
- The product's primary value turns out to be bespoke document-conversion services rather than repeatable software.

None of these necessarily kills the IDML commercial opportunity. They may, however, invalidate the broader ambient-localization thesis.

## 10. The strategic success condition

The strongest test is not whether Aquilla can translate IDML. It is whether a customer can maintain a multilingual publication through repeated source changes without ever creating a translation project or manually managing a synchronization cycle.

If that works, and the same architecture extends to a second content format, you have evidence of something substantially more general than an IDML translation tool: the beginnings of a multilingual content dependency system.

That is the potential disruptive innovation: not a better place to do translation work, but a way to make most translation-management work unnecessary.

The commercial advantage of beginning with the paid IDML engagement is that the first experiment can produce customer value even if the larger disruption thesis turns out to be wrong.

Recommendation: make a working, lossless, incremental IDML round trip with preserved human corrections the first milestone. Everything else—generated interfaces, email agents, drive integrations, multimodal production—should earn its place by demonstrating that it makes this fundamental loop faster, simpler, or more reliable.
