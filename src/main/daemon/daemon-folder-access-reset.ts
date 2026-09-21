// The remedy for the third of affected users whom a freshly forked daemon is still denied
// (STA-7948) even though Orca itself is allowed: clear Orca's TCC row for that folder class so
// macOS asks again, have the app touch the folder so the prompt names Orca, then re-probe.

import { app } from 'electron'
import type { Dir } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { DaemonPtyCwdClass } from '../../shared/daemon-adoption-telemetry'
import type { EventProps } from '../../shared/telemetry-events'
import { readMacosBundleId, resetMacosTccPermission } from '../macos-tcc-reset'
import { track } from '../telemetry/client'
import {
  getDaemonFolderAccessMismatch,
  getDaemonFolderAccessTarget,
  refreshDaemonFolderAccessProbe,
  type DaemonFolderAccessMismatchNotice,
  type FreshDaemonAccess
} from './daemon-folder-access-mismatch'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'

/**
 * `unsupported` covers every reason the remedy does not apply — no stored evidence, a folder class
 * TCC has no service for, another platform, or a bundle id we cannot read — because the dialog
 * says the same thing to the user for all of them.
 */
export type DaemonFolderAccessResetResult =
  | { outcome: 'unsupported' }
  | { outcome: 'reset_failed' }
  | { outcome: 'probed'; mismatch: DaemonFolderAccessMismatchNotice | null }

/** Only the folders macOS gates behind a per-app TCC row; the rest have nothing to reset. */
const TCC_SERVICE_BY_CWD_CLASS: Partial<Record<DaemonPtyCwdClass, string>> = {
  documents: 'SystemPolicyDocumentsFolder',
  desktop: 'SystemPolicyDesktopFolder',
  downloads: 'SystemPolicyDownloadsFolder'
}

/** `Orca.app/Contents/MacOS/Orca` → `Orca.app`, the bundle whose id owns every TCC row. */
function runningAppBundlePath(): string {
  return resolve(dirname(app.getPath('exe')), '..', '..')
}

/**
 * Why the app reads the folder itself: TCC raises its prompt against the process that made the
 * syscall, so a daemon-side read would put the daemon on screen, or nothing at all. Async
 * throughout — the prompt blocks the calling syscall until the user answers it, and the sync
 * variant would take main's event loop down with it for the whole time the dialog is up.
 */
async function promptByReadingFolder(path: string): Promise<void> {
  let dir: Dir | undefined
  try {
    dir = await opendir(path)
    await dir.read()
  } catch {
    // The verdict is the re-probe's job; this read exists only to raise the prompt.
  } finally {
    await dir?.close().catch(() => {})
  }
}

const RESET_OUTCOME_ACTION = {
  allowed: 'reset_outcome_allowed',
  denied: 'reset_outcome_still_denied',
  unknown: 'reset_outcome_unknown'
} as const satisfies Record<FreshDaemonAccess, EventProps<'daemon_folder_access_notice'>['action']>

/**
 * Emitted from main, not the renderer: nobody has verified this remedy on an affected machine, so
 * the verdict the re-probe returns is the only evidence the feature works.
 */
function emitResetOutcome(
  cwdClass: DaemonPtyCwdClass,
  mismatch: DaemonFolderAccessMismatchNotice | null
): void {
  try {
    track('daemon_folder_access_notice', {
      action: RESET_OUTCOME_ACTION[mismatch?.freshDaemonAccess ?? 'unknown'],
      cwd_class: cwdClass
    })
  } catch {
    // Best-effort: a dropped event must not turn a completed reset into a failure.
  }
}

export async function resetFolderAccessForDaemon(
  identity: DaemonEndpointIdentity | null
): Promise<DaemonFolderAccessResetResult> {
  if (process.platform !== 'darwin') {
    return { outcome: 'unsupported' }
  }
  const target = getDaemonFolderAccessTarget(identity)
  const service = target ? TCC_SERVICE_BY_CWD_CLASS[target.cwdClass] : undefined
  if (!target || service === undefined) {
    return { outcome: 'unsupported' }
  }
  const bundleId = readMacosBundleId(runningAppBundlePath())
  if (bundleId === null) {
    return { outcome: 'unsupported' }
  }
  if (!resetMacosTccPermission(service, bundleId).ok) {
    return { outcome: 'reset_failed' }
  }
  await promptByReadingFolder(target.canonicalPath)
  await refreshDaemonFolderAccessProbe(identity, { force: true })
  const mismatch = getDaemonFolderAccessMismatch(identity)
  emitResetOutcome(target.cwdClass, mismatch)
  return { outcome: 'probed', mismatch }
}
