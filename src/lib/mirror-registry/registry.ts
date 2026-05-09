/**
 * Mirror registry — bridges external state sources (Y.Doc, etc.) into the
 * local SQLite store + outbox.
 *
 * See DATA_PERSISTENCE_PLAN.md §8.8. Each subsystem (translation_text,
 * threads, attachments, validations, …) ships its own Mirror module that
 * the registry orchestrates.
 *
 * Lifecycle on `startAll(ctx)`:
 *   1. Run every mirror's `bootstrap` in registration order. A bootstrap
 *      may import existing source state into local-store on first project
 *      open. Throwing aborts startup before any mirror has been attached.
 *   2. Run every mirror's `attach` in registration order. Each returns a
 *      dispose function. The combined disposer (returned from startAll)
 *      tears them all down on unmount.
 *
 * Mirror-specific dependencies (a Y.Doc reference, etc.) live in the
 * mirror's own closure — pass them at construction time. The MirrorContext
 * carries only the cross-cutting tools every mirror needs.
 */

import type { LocalStore } from "@/lib/local-store"

export interface MirrorContext {
  store: LocalStore
  /** Current user id; goes into `last_edited_by` and outbox audit trail. */
  actorId: string
  /** Override for tests; production passes `Date.now`. */
  now: () => number
}

export interface Mirror {
  /** Stable identifier, unique within a registry. */
  name: string
  /**
   * One-shot import on first mount. May import from the source into the
   * local store when the destination is empty. Should be idempotent —
   * calling twice is a no-op.
   */
  bootstrap(ctx: MirrorContext): Promise<void>
  /**
   * Install observers on the source. Returns a dispose function that
   * tears them down. Must be safe to call dispose multiple times.
   */
  attach(ctx: MirrorContext): () => void
}

export class MirrorRegistry {
  private mirrors: Mirror[] = []
  private seenNames = new Set<string>()

  register(mirror: Mirror): void {
    if (this.seenNames.has(mirror.name)) {
      throw new Error(
        `mirror "${mirror.name}" is already registered`,
      )
    }
    this.seenNames.add(mirror.name)
    this.mirrors.push(mirror)
  }

  names(): string[] {
    return this.mirrors.map((m) => m.name)
  }

  /**
   * Bootstrap every mirror, then attach every mirror. Returns a single
   * dispose function that runs every mirror's individual disposer.
   */
  async startAll(ctx: MirrorContext): Promise<() => void> {
    for (const mirror of this.mirrors) {
      await mirror.bootstrap(ctx)
    }
    const disposers: Array<() => void> = []
    for (const mirror of this.mirrors) {
      disposers.push(mirror.attach(ctx))
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      for (const d of disposers) {
        try {
          d()
        } catch {
          /* swallow per-mirror dispose errors so siblings still tear down */
        }
      }
    }
  }
}
