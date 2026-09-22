import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSectionProgress, useSectionProgressState } from './useSectionProgress'

const resource = vi.fn()
const invalidate = vi.fn()
vi.mock('@/lib/progress/file-progress-resource', () => ({
  useFileProgressResource: (...args: unknown[]) => resource(...args),
  invalidateFileProgress: (...args: unknown[]) => invalidate(...args),
}))

describe('useSectionProgress', () => {
  // These spies are module-level, and every "did not revalidate" assertion
  // below is only meaningful against a clean slate.
  beforeEach(() => invalidate.mockClear())

  it('maps compact server counts to sidebar percentages without loading cells', () => {
    resource.mockReturnValue({
      progress: {
        fileId: 'file-1',
        revision: 7,
        validationCount: 2,
        file: { totalCount: 3, filledCount: 2, validatedCount: 1, validationLevels: [2, 1] },
        sections: [{
          key: 'GEN 1', totalCount: 2, filledCount: 1, validatedCount: 1,
          validationLevels: [2, 1],
        }],
      },
      loading: false,
      error: false,
      retry: vi.fn(),
    })
    const getToken = vi.fn(async () => 'token')
    const { result } = renderHook(() => useSectionProgress('project-1', 'file-1', 2, getToken))
    expect(result.current).toEqual([expect.objectContaining({
      label: 'GEN 1',
      textCompleted: 50,
      textValidated: 50,
      textValidationLevels: [100, 50],
    })])
  })

  it('exposes a retry state without falling back to the full cells endpoint', () => {
    const retry = vi.fn()
    resource.mockReturnValue({ progress: null, loading: false, error: true, retry })
    const { result } = renderHook(() =>
      useSectionProgressState('project-1', 'file-1', 1, async () => 'token'),
    )
    expect(result.current.sections).toEqual([])
    expect(result.current.error).toBe(true)
    result.current.retry()
    expect(retry).toHaveBeenCalledOnce()
  })

  it('revalidates the compact snapshot when validationCount changes', async () => {
    resource.mockReturnValue({ progress: null, loading: true, error: false, retry: vi.fn() })
    const getToken = async () => 'token'
    const { rerender } = renderHook(
      ({ count }) => useSectionProgressState('project-1', 'file-1', count, getToken),
      { initialProps: { count: 1 } },
    )
    expect(invalidate).not.toHaveBeenCalled()
    rerender({ count: 2 })
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith('project-1', 'file-1'))
  })

  it('revalidates when the structural-cell policy changes (AQU-1083)', async () => {
    // The cached snapshot holds numbers the SERVER already resolved the policy
    // against, and nothing in it says which policy that was. Without this the
    // chapter tiles keep painting the answer the org just changed away from.
    resource.mockReturnValue({ progress: null, loading: true, error: false, retry: vi.fn() })
    const getToken = async () => 'token'
    const { rerender } = renderHook(
      ({ countStructural }) =>
        useSectionProgressState('project-1', 'file-1', 1, getToken, countStructural),
      { initialProps: { countStructural: true } },
    )
    expect(invalidate).not.toHaveBeenCalled()
    rerender({ countStructural: false })
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith('project-1', 'file-1'))
  })

  it('does not revalidate on a re-render that changes neither policy', async () => {
    // Guards the ref bookkeeping: the two policies share one ref now, and
    // reading either one wrong would refetch the whole sidebar every render.
    resource.mockReturnValue({ progress: null, loading: true, error: false, retry: vi.fn() })
    const getToken = async () => 'token'
    const { rerender } = renderHook(
      ({ label }) => {
        void label
        return useSectionProgressState('project-1', 'file-1', 2, getToken, false)
      },
      { initialProps: { label: 'a' } },
    )
    rerender({ label: 'b' })
    rerender({ label: 'c' })
    expect(invalidate).not.toHaveBeenCalled()
  })
})
