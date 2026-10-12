// AQU-1837: deferBestEffort keeps non-fatal post-commit work off the response
// path — via ctx.waitUntil when there is a context, and behind a bounded await
// when there is not.

import { describe, it, expect, vi, afterEach } from 'vitest'

import { deferBestEffort, DEFER_FALLBACK_TIMEOUT_MS } from '../events/defer-best-effort'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('deferBestEffort — with an ExecutionContext', () => {
  it('returns without waiting for the work and registers it on ctx.waitUntil', async () => {
    const work = deferred<void>()
    let workSettled = false
    const tracked = work.promise.then(() => {
      workSettled = true
    })
    const registered: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => registered.push(p) }

    await deferBestEffort(tracked, ctx, 'test')

    // The whole point: the caller is already past the await while the work
    // is still in flight, so the response is not charged for it.
    expect(workSettled).toBe(false)
    expect(registered).toHaveLength(1)

    work.resolve()
    await registered[0]
    expect(workSettled).toBe(true)
  })

  it('hands waitUntil a promise that never rejects, so failed work cannot fail the request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const registered: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => registered.push(p) }

    await deferBestEffort(Promise.reject(new Error('DO unreachable')), ctx, 'test')

    await expect(registered[0]).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})

describe('deferBestEffort — without an ExecutionContext', () => {
  it('awaits the work, so already-in-flight subrequests are not abandoned', async () => {
    let workSettled = false
    await deferBestEffort(
      Promise.resolve().then(() => {
        workSettled = true
      }),
      undefined,
      'test',
    )
    expect(workSettled).toBe(true)
  })

  it('gives up waiting after the fallback timeout instead of inheriting a stalled peer', async () => {
    vi.useFakeTimers()
    const work = deferred<void>()

    let returned = false
    const call = deferBestEffort(work.promise, undefined, 'test').then(() => {
      returned = true
    })

    await vi.advanceTimersByTimeAsync(DEFER_FALLBACK_TIMEOUT_MS - 1)
    expect(returned).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await call
    expect(returned).toBe(true)

    // The work itself is NOT cancelled — it just stops being waited on.
    work.resolve()
  })

  it('swallows a rejection rather than throwing into the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      deferBestEffort(Promise.reject(new Error('DO unreachable')), undefined, 'test'),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})
