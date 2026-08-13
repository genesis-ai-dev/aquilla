# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report privately through either route:

- **GitHub** — [open a private security advisory](https://github.com/genesis-ai-dev/aquilla/security/advisories/new)
  on this repository (preferred; it gives us a private thread with you).
- **Email** — `support@aquilla.app` with `SECURITY` in the subject line.

What helps us most, in rough priority order: the affected URL or file path, the steps to
reproduce, and what an attacker gets if it works. A proof of concept is welcome but not
required — a clear description beats a polished exploit.

We aim to acknowledge within 3 business days. Aquilla is a small team, so please allow us
a reasonable window to ship a fix before public disclosure; tell us if you have a deadline
in mind and we will work to it rather than around it.

## Scope

In scope: `aquilla.app`, `api.aquilla.app` (identity, sync, and chat surfaces), the
`aquilla-*` Cloudflare Workers, the Agent API (`/api/v1/external/*`), and the desktop
(Tauri) shell.

Out of scope: findings against third-party services we merely integrate with (Cloudflare,
Neon, OpenRouter, Monday.com, door43) — report those to the relevant vendor. Also out of
scope: volumetric denial of service, and reports consisting only of automated scanner
output with no demonstrated impact.

A note on the Content-Security-Policy: most of it currently ships as
`Content-Security-Policy-Report-Only` on purpose, while its violations are collected. A
report that the report-only policy does not block something is expected rather than a
finding — see `worker/security-headers.ts` for what is enforced today.

## Testing guidelines

Please use your own account and your own test project. **Do not access, modify, or
exfiltrate translation content belonging to anyone else** — much of the work hosted here
is unpublished, and some of it is sensitive to the people who produced it. If you land in
someone else's data accidentally, stop, and tell us what you saw so we can assess it.

Good-faith research that follows these guidelines is welcome, and we will not pursue
action over it.

## For maintainers

The current posture, threat model, and open items live in:

- `docs/OPSEC-REVIEW-2026-08-11.md` — **the current review.** Its §6 carries the live status
  of every finding from both documents below. Start here.
- `docs/OPSEC-REVIEW-2026-08-10.md` — the previous pass (OPS-1…OPS-7); still the reference
  for the asset ranking (§1) and threat model (§2), which the current review does not restate.
- `docs/SECURITY-NOTES-2026-06-10.md` — the original point-in-time code audit (SEC-1…SEC-11).

When a report lands, update the status table in the current review so the documents never
disagree about what is still open. For routine re-checks, amend the current review in place
rather than adding another dated file — see its §0.
