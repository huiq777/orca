import { beforeEach, describe, expect, it, vi } from 'vitest'
import { validate } from '../telemetry/validator'

const { trackMock, probeMock } = vi.hoisted(() => ({ trackMock: vi.fn(), probeMock: vi.fn() }))
vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('./daemon-folder-access-probe', () => ({
  probeFolderAccessForFreshDaemon: probeMock
}))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  homedir: () => '/Users/alice'
}))

import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import {
  clearDaemonFolderAccessMismatch,
  getDaemonFolderAccessMismatch,
  getDaemonFolderAccessTarget,
  recordDaemonFolderAccessMismatch,
  refreshDaemonFolderAccessProbe,
  resetDaemonFolderAccessMismatchForTests
} from './daemon-folder-access-mismatch'

const DAEMON: DaemonEndpointIdentity = { pid: 1530, startedAtMs: 1_700_000, launchNonce: 'n1' }
const RESTARTED: DaemonEndpointIdentity = { pid: 1610, startedAtMs: 1_700_900, launchNonce: 'n2' }
const DOCUMENTS = '/Users/alice/Documents/repo'

beforeEach(() => {
  resetDaemonFolderAccessMismatchForTests()
  trackMock.mockReset()
  probeMock.mockReset().mockResolvedValue('unknown')
  vi.useRealTimers()
})

/** The record path starts the probe without awaiting it; this is where its result lands. */
async function settleProbe(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('daemon folder access mismatch evidence', () => {
  it('has nothing until a spawn records one', () => {
    expect(getDaemonFolderAccessMismatch(DAEMON)).toBeNull()
  })

  it('classifies the recorded cwd and keeps only the latest entry', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    expect(getDaemonFolderAccessMismatch(DAEMON)?.cwdClass).toBe('documents')

    recordDaemonFolderAccessMismatch(DAEMON, '/Users/alice/Desktop/other')
    expect(getDaemonFolderAccessMismatch(DAEMON)?.cwdClass).toBe('desktop')
  })

  it('clears when the same daemon later reads a cwd of the same folder class', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    clearDaemonFolderAccessMismatch(DAEMON, '/Users/alice/Documents/other-repo')
    expect(getDaemonFolderAccessMismatch(DAEMON)).toBeNull()
  })

  it('keeps the evidence when the same daemon reads a folder of another class', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    clearDaemonFolderAccessMismatch(DAEMON, '/Users/alice/code/repo')
    expect(getDaemonFolderAccessMismatch(DAEMON)).not.toBeNull()
  })

  it('ignores a clear from a different daemon', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    clearDaemonFolderAccessMismatch(RESTARTED, DOCUMENTS)
    expect(getDaemonFolderAccessMismatch(DAEMON)).not.toBeNull()
  })

  // This is the whole restart remedy: a new daemon has a new identity, so the poll goes quiet
  // without anyone probing the folder again.
  it('returns null once the daemon that earned it has been replaced', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    expect(getDaemonFolderAccessMismatch(RESTARTED)).toBeNull()
  })

  it('returns null when there is no current daemon identity', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    expect(getDaemonFolderAccessMismatch(null)).toBeNull()
  })

  it('records nothing for a daemon that has no identity yet', () => {
    recordDaemonFolderAccessMismatch(null, DOCUMENTS)
    expect(getDaemonFolderAccessMismatch(DAEMON)).toBeNull()
  })

  it('gives one daemon a stable scope and two daemons different scopes', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    const first = getDaemonFolderAccessMismatch(DAEMON)?.daemonScope
    expect(getDaemonFolderAccessMismatch(DAEMON)?.daemonScope).toBe(first)

    recordDaemonFolderAccessMismatch(RESTARTED, DOCUMENTS)
    expect(getDaemonFolderAccessMismatch(RESTARTED)?.daemonScope).not.toBe(first)
  })

  it('keeps every path fragment out of the scope', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    const scope = getDaemonFolderAccessMismatch(DAEMON)?.daemonScope ?? ''
    expect(scope).toMatch(/^[0-9a-f]{16}$/)
    for (const fragment of ['alice', 'Documents', 'repo', 'Users']) {
      expect(scope).not.toContain(fragment)
    }
  })
})

describe('daemon_folder_access_notice shown', () => {
  it('emits a validator-accepted payload once per scope that leaves main', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    getDaemonFolderAccessMismatch(DAEMON)
    getDaemonFolderAccessMismatch(DAEMON)

    expect(trackMock).toHaveBeenCalledTimes(1)
    const [name, props] = trackMock.mock.calls[0]
    expect(name).toBe('daemon_folder_access_notice')
    expect(props).toEqual({ action: 'shown', cwd_class: 'documents' })
    expect(validate('daemon_folder_access_notice', props).ok).toBe(true)
  })

  it('does not emit while the evidence is withheld', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    getDaemonFolderAccessMismatch(RESTARTED)
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('emits again for a replacement daemon that is denied too', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    getDaemonFolderAccessMismatch(DAEMON)
    recordDaemonFolderAccessMismatch(RESTARTED, DOCUMENTS)
    getDaemonFolderAccessMismatch(RESTARTED)
    // The replacement's own denial also counts a restart outcome; this asserts only `shown`.
    const shown = trackMock.mock.calls.filter(([, props]) => props.action === 'shown')
    expect(shown).toHaveLength(2)
  })

  it('still hands out the notice when the telemetry client throws', () => {
    trackMock.mockImplementationOnce(() => {
      throw new Error('posthog exploded')
    })
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    expect(getDaemonFolderAccessMismatch(DAEMON)?.cwdClass).toBe('documents')
  })
})

describe('restartWillHelp', () => {
  it('starts unanswered and never blocks the spawn path on the child', () => {
    let release: (value: string) => void = () => {}
    probeMock.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve
      })
    )
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)

    expect(getDaemonFolderAccessMismatch(DAEMON)?.restartWillHelp).toBeNull()
    release('ok')
  })

  it('probes the folder the spawn was denied on', async () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    await settleProbe()

    expect(probeMock).toHaveBeenCalledWith(DOCUMENTS)
  })

  it.each([
    ['ok', true],
    ['denied', false],
    ['missing', null],
    ['other', null],
    ['unknown', null]
  ])('maps a %s probe to %s', async (outcome, expected) => {
    probeMock.mockResolvedValue(outcome)
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    await settleProbe()

    expect(getDaemonFolderAccessMismatch(DAEMON)?.restartWillHelp).toBe(expected)
  })

  it('drops a probe whose entry was replaced while the child ran', async () => {
    let release: (value: string) => void = () => {}
    probeMock.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        release = resolve
      })
    )
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)

    probeMock.mockResolvedValue('denied')
    recordDaemonFolderAccessMismatch(DAEMON, '/Users/alice/Desktop/other')
    await settleProbe()
    release('ok')
    await settleProbe()

    const notice = getDaemonFolderAccessMismatch(DAEMON)
    expect(notice?.cwdClass).toBe('desktop')
    expect(notice?.restartWillHelp).toBe(false)
  })

  it('survives a probe that rejects', async () => {
    probeMock.mockRejectedValue(new Error('spawn failed'))
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    await settleProbe()

    expect(getDaemonFolderAccessMismatch(DAEMON)?.restartWillHelp).toBeNull()
  })
})

describe('refreshDaemonFolderAccessProbe', () => {
  it('re-probes a denial so step one can complete itself', async () => {
    probeMock.mockResolvedValue('denied')
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    await settleProbe()
    expect(getDaemonFolderAccessMismatch(DAEMON)?.restartWillHelp).toBe(false)

    vi.setSystemTime(Date.now() + 6_000)
    probeMock.mockResolvedValue('ok')
    await refreshDaemonFolderAccessProbe(DAEMON)

    expect(getDaemonFolderAccessMismatch(DAEMON)?.restartWillHelp).toBe(true)
  })

  it('reuses a probe younger than the refresh interval', async () => {
    probeMock.mockResolvedValue('denied')
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    await settleProbe()
    expect(probeMock).toHaveBeenCalledTimes(1)

    await refreshDaemonFolderAccessProbe(DAEMON)

    expect(probeMock).toHaveBeenCalledTimes(1)
  })

  it('treats a settled true as final', async () => {
    probeMock.mockResolvedValue('ok')
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    await settleProbe()
    vi.setSystemTime(Date.now() + 60_000)

    await refreshDaemonFolderAccessProbe(DAEMON)

    expect(probeMock).toHaveBeenCalledTimes(1)
  })

  it('re-probes an unanswered entry once the interval has passed', async () => {
    probeMock.mockResolvedValue('other')
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    await settleProbe()
    vi.setSystemTime(Date.now() + 6_000)

    await refreshDaemonFolderAccessProbe(DAEMON)

    expect(probeMock).toHaveBeenCalledTimes(2)
  })

  it('does nothing for a daemon the evidence does not belong to', async () => {
    probeMock.mockResolvedValue('denied')
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    await settleProbe()
    vi.setSystemTime(Date.now() + 6_000)

    await refreshDaemonFolderAccessProbe(RESTARTED)
    await refreshDaemonFolderAccessProbe(null)

    expect(probeMock).toHaveBeenCalledTimes(1)
  })

  it('joins an in-flight probe instead of starting a second child', async () => {
    let release: (value: string) => void = () => {}
    probeMock.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve
      })
    )
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    const joined = refreshDaemonFolderAccessProbe(DAEMON)
    release('ok')
    await joined

    expect(probeMock).toHaveBeenCalledTimes(1)
    expect(getDaemonFolderAccessMismatch(DAEMON)?.restartWillHelp).toBe(true)
  })

  // The reset's caller needs a verdict from after the reset, and the interval is what would
  // otherwise hand it the pre-reset one.
  it('probes again inside the refresh interval when forced', async () => {
    probeMock.mockResolvedValue('denied')
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    await settleProbe()
    probeMock.mockResolvedValue('ok')

    await refreshDaemonFolderAccessProbe(DAEMON, { force: true })

    expect(probeMock).toHaveBeenCalledTimes(2)
    expect(getDaemonFolderAccessMismatch(DAEMON)?.restartWillHelp).toBe(true)
  })

  // A probe that started before the reset would otherwise win the race and discard the forced
  // one's write, reporting the state the reset was meant to change.
  it('waits for an older in-flight probe and still lands its own verdict', async () => {
    const releases: ((value: string) => void)[] = []
    probeMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releases.push(resolve)
        })
    )
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    await settleProbe()

    const forced = refreshDaemonFolderAccessProbe(DAEMON, { force: true })
    releases[0]('denied')
    await settleProbe()
    releases[1]('ok')
    await forced

    expect(probeMock).toHaveBeenCalledTimes(2)
    expect(getDaemonFolderAccessMismatch(DAEMON)?.restartWillHelp).toBe(true)
  })

  it('keeps a settled true final even under force', async () => {
    probeMock.mockResolvedValue('ok')
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    await settleProbe()

    await refreshDaemonFolderAccessProbe(DAEMON, { force: true })

    expect(probeMock).toHaveBeenCalledTimes(1)
  })
})

describe('getDaemonFolderAccessTarget', () => {
  it('hands the remedy the folder the evidence is about', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)

    expect(getDaemonFolderAccessTarget(DAEMON)).toEqual({
      canonicalPath: DOCUMENTS,
      cwdClass: 'documents'
    })
  })

  it('has no target for another daemon, no daemon, or no evidence', () => {
    expect(getDaemonFolderAccessTarget(DAEMON)).toBeNull()

    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)

    expect(getDaemonFolderAccessTarget(RESTARTED)).toBeNull()
    expect(getDaemonFolderAccessTarget(null)).toBeNull()
  })

  // Reading the target must not be what makes the notice count as shown.
  it('does not emit the shown event', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    trackMock.mockReset()

    getDaemonFolderAccessTarget(DAEMON)

    expect(trackMock).not.toHaveBeenCalled()
  })
})

describe('restart outcome', () => {
  it('counts a replacement daemon that can read the folder as fixed', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    trackMock.mockReset()

    clearDaemonFolderAccessMismatch(RESTARTED, '/Users/alice/Documents/other')

    expect(trackMock).toHaveBeenCalledWith('daemon_folder_access_notice', {
      action: 'restart_outcome_fixed',
      cwd_class: 'documents'
    })
    expect(validate('daemon_folder_access_notice', trackMock.mock.calls[0][1]).ok).toBe(true)
  })

  it('counts a replacement daemon denied the same folder as still denied', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    trackMock.mockReset()

    recordDaemonFolderAccessMismatch(RESTARTED, DOCUMENTS)

    expect(trackMock).toHaveBeenCalledWith('daemon_folder_access_notice', {
      action: 'restart_outcome_still_denied',
      cwd_class: 'documents'
    })
    expect(validate('daemon_folder_access_notice', trackMock.mock.calls[0][1]).ok).toBe(true)
  })

  it('counts one outcome per restart, not one per spawn', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    trackMock.mockReset()

    clearDaemonFolderAccessMismatch(RESTARTED, DOCUMENTS)
    clearDaemonFolderAccessMismatch(RESTARTED, DOCUMENTS)

    const outcomes = trackMock.mock.calls.filter(([, props]) =>
      String(props.action).startsWith('restart_outcome_')
    )
    expect(outcomes).toHaveLength(1)
  })

  // The same daemon reading back is a TCC grant landing mid-session, not a restart's verdict.
  it('says nothing when the daemon that was denied reads the folder itself', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    trackMock.mockReset()

    clearDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)

    expect(trackMock).not.toHaveBeenCalled()
  })

  // A readable ~/code after a Documents denial says nothing about Documents.
  it('says nothing for a spawn in another folder class', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    trackMock.mockReset()

    clearDaemonFolderAccessMismatch(RESTARTED, '/Users/alice/code/repo')
    recordDaemonFolderAccessMismatch(RESTARTED, '/Users/alice/Desktop/x')

    const outcomes = trackMock.mock.calls.filter(([, props]) =>
      String(props.action).startsWith('restart_outcome_')
    )
    expect(outcomes).toHaveLength(0)
  })

  it('says nothing when no denial preceded the spawn', () => {
    clearDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    expect(trackMock).not.toHaveBeenCalled()
  })
})
