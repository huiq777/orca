import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '../shared/child-process/run-process'

const { runProcessSyncMock } = vi.hoisted(() => ({ runProcessSyncMock: vi.fn() }))
vi.mock('../shared/child-process/run-process', () => ({ runProcessSync: runProcessSyncMock }))

import { readMacosBundleId, resetMacosTccPermission } from './macos-tcc-reset'

function processResult(overrides: Partial<ProcessResult>): ProcessResult {
  return {
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    outputTruncated: false,
    ...overrides
  }
}

beforeEach(() => {
  runProcessSyncMock.mockReset()
})

describe('readMacosBundleId', () => {
  it('reads CFBundleIdentifier out of the bundle’s Info.plist', () => {
    runProcessSyncMock.mockReturnValue(processResult({ stdout: 'com.stablyai.orca\n' }))

    expect(readMacosBundleId('/Applications/Orca.app')).toBe('com.stablyai.orca')
    expect(runProcessSyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/usr/libexec/PlistBuddy',
        args: ['-c', 'Print :CFBundleIdentifier', '/Applications/Orca.app/Contents/Info.plist']
      })
    )
  })

  it.each([
    ['a non-zero exit', processResult({ code: 1, stderr: 'Print: Entry, Does Not Exist' })],
    ['empty output', processResult({ stdout: '  \n' })]
  ])('returns null on %s', (_label, result) => {
    runProcessSyncMock.mockReturnValue(result)

    expect(readMacosBundleId('/Applications/Orca.app')).toBeNull()
  })

  it('returns null rather than throwing when PlistBuddy cannot be started', () => {
    runProcessSyncMock.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    expect(readMacosBundleId('/Applications/Orca.app')).toBeNull()
  })
})

describe('resetMacosTccPermission', () => {
  it('clears the service’s row for the bundle id', () => {
    runProcessSyncMock.mockReturnValue(processResult({}))

    expect(resetMacosTccPermission('SystemPolicyDocumentsFolder', 'com.stablyai.orca')).toEqual({
      ok: true
    })
    expect(runProcessSyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/usr/bin/tccutil',
        args: ['reset', 'SystemPolicyDocumentsFolder', 'com.stablyai.orca']
      })
    )
  })

  // The observed shape on macOS 15: exit 64, everything on stderr, nothing on stdout.
  it('reports the unknown-bundle-id failure tccutil writes to stderr', () => {
    runProcessSyncMock.mockReturnValue(
      processResult({
        code: 64,
        stderr: 'tccutil: No such bundle identifier "com.example.absent"\n'
      })
    )

    expect(resetMacosTccPermission('SystemPolicyDesktopFolder', 'com.example.absent')).toEqual({
      ok: false,
      detail: 'tccutil: No such bundle identifier "com.example.absent"'
    })
  })

  it.each([
    ['stdout when stderr is empty', processResult({ code: 1, stdout: 'refused\n' }), 'refused'],
    ['the exit code when both are empty', processResult({ code: 70 }), 'exit 70'],
    [
      'an unknown exit when the process was signalled',
      processResult({ code: null }),
      'exit unknown'
    ]
  ])('falls back to %s', (_label, result, detail) => {
    runProcessSyncMock.mockReturnValue(result)

    expect(resetMacosTccPermission('SystemPolicyDownloadsFolder', 'com.stablyai.orca')).toEqual({
      ok: false,
      detail
    })
  })

  it('reports a failure to start as a failed reset', () => {
    runProcessSyncMock.mockImplementation(() => {
      throw new Error('EACCES')
    })

    expect(resetMacosTccPermission('SystemPolicyDocumentsFolder', 'com.stablyai.orca')).toEqual({
      ok: false,
      detail: 'EACCES'
    })
  })
})
