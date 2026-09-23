# Pricing-aware onboarding handoff

Prepared for the dedicated onboarding rework requested by Ryder. This is a
handoff, not a dispatch or permission to change billing policy.

## Goal

Help a new or returning person reach useful work in the correct workspace while
preserving their selected plan. Make personal ownership, shared team ownership,
covered access, and available capabilities clear before invitations or payment.

## Existing contracts to reuse

- `src/lib/billing/intent.ts` validates and normalizes marketing selections.
  Preserve its offer/interval/quantity through sign-in and account creation.
- `/billing/select` lets a person explicitly choose a workspace where they have
  billing authority. The server review checks workspace scope and eligibility.
- New personal and team workspaces have persisted `billing_scope`; historical
  workspaces can remain unconfirmed. Do not classify them from a name or role.
- Billing review never grants access. Stripe reconciliation records plans only
  from verified server-side payment evidence. Customer checkout is still gated.
- Covered and negotiated access must not be converted to self-service purchases.
- A workspace owns its projects and allowance. Joining a team does not transfer
  personal projects, share a personal subscription, or cancel that subscription.
- Manual editing, existing work, and export remain accessible after AI exhaustion.

## Acceptance criteria

1. A selected paid offer survives authentication and every onboarding branch.
   Returning users can review it against an existing eligible workspace.
2. New users understand which workspace owns their first project. Show the
   selected workspace in the final review and first useful-work action.
3. Free onboarding stays available without payment details. Explain any advanced
   AI restriction from the server capability response, not a marketing label.
4. Team setup explains shared ownership and allowance before inviting people.
   Do not infer reviewer permissions or collaborator limits pending approval.
5. Covered-access discovery offers the existing inquiry/activation path without
   implying that declaring affiliation grants access or requires a paid plan.
6. Back, reload, sign-out, account switching, and network retry preserve valid
   intent without leaking another account's workspace or checkout state.
7. Unknown, incompatible, or obsolete selections show a recoverable review state.
   Do not silently substitute another plan, workspace, or billing interval.
8. The completion action reaches useful work: open or create a project, choose
   an import, or resume an existing project. Preserve existing import contracts.
9. The UI never exposes internal credits, invents a usage percentage, guarantees
   word counts, or presents an unimplemented capability as available.

## Coordination and ownership

- Use a separate issue and worktree. Follow AGENTS.md's issue workflow; new
  issues begin in Triage and require promotion before autonomous pickup.
- Read the latest `docs/runbooks/stripe-go-live.md` and current billing contracts
  before starting. Request a contract change in the shared runbook before
  changing its producer and consumer together.
- Own onboarding components, their tests, and onboarding documentation. Billing
  catalog, payments, lifecycle, entitlement persistence, and usage enforcement
  remain with AQU-837. Do not rewrite those modules or commit another task's edits.
- Reuse `/billing/select` and the intent helper instead of duplicating checkout
  logic in the wizard. Coordinate any shared-file edit before applying it.
- Keep changes locally committed with the onboarding issue ID. Do not deploy,
  enable checkout, alter live Stripe resources, or auto-migrate existing users.

## Verification and completion

Extend relevant RTL tests for wizard steps and controls. Extend existing auth,
workspace ownership, and first-project/import smoke journeys where behavior
crosses boundaries; reuse page objects. Do not create smoke tests for UI-only
step toggles. Run targeted tests, the production build, and browser verification.

Reconcile the behavior spec after verification. Update this handoff and the
Stripe runbook with the assigned issue, worktree, shared-contract changes,
verification evidence, and remaining questions before returning integration.

## Decisions that must remain explicit

Individual guest-reviewer actions and limits, whether Team's collaborator count
includes the owner, covered-access qualification, and onboarding support promises
remain approval questions. Do not resolve them by changing copy or granting roles.
