// Clearing a macOS TCC row, plus the bundle id every row is keyed by. Shared because two remedies
// must issue the identical `tccutil reset`: the computer-use helper's stale-grant reset and the
// daemon folder-access fix (STA-7948), where clearing the row is what makes macOS ask again.

import { join } from 'node:path'
import { runProcessSync, type ProcessResult } from '../shared/child-process/run-process'

/** Bounded so a wedged helper cannot hold main: neither binary prompts, so neither should linger. */
const TCC_COMMAND_TIMEOUT_MS = 10_000

export type MacosTccResetResult = { ok: true } | { ok: false; detail: string }

/**
 * The bundle's `CFBundleIdentifier`, or null when it cannot be read — Info.plist is usually a
 * binary plist, so PlistBuddy is the only reader that works on both encodings.
 */
export function readMacosBundleId(appBundlePath: string): string | null {
  try {
    const result = runProcessSync({
      program: '/usr/libexec/PlistBuddy',
      args: ['-c', 'Print :CFBundleIdentifier', join(appBundlePath, 'Contents', 'Info.plist')],
      timeoutMs: TCC_COMMAND_TIMEOUT_MS
    })
    if (result.code !== 0) {
      return null
    }
    return result.stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Clears the TCC row for one service and bundle id, so the next access re-prompts.
 *
 * Failure is data, not an exception: `tccutil` exits 64 and explains itself on stderr when
 * LaunchServices does not know the bundle id, which is the ordinary outcome for an app running
 * from an unregistered location.
 */
export function resetMacosTccPermission(service: string, bundleId: string): MacosTccResetResult {
  let result: ProcessResult
  try {
    result = runProcessSync({
      program: '/usr/bin/tccutil',
      args: ['reset', service, bundleId],
      timeoutMs: TCC_COMMAND_TIMEOUT_MS
    })
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'tccutil failed to start' }
  }
  if (result.code === 0) {
    return { ok: true }
  }
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code ?? 'unknown'}`
  return { ok: false, detail }
}
