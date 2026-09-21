// Evidence behind the macOS folder-access notice (STA-7948). Main-process only, at most one entry,
// keyed by the daemon that produced it: a restart mints a new identity, so the next read returns
// null and the notice clears without probing anything.

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import {
  classifyDaemonPtyCwd,
  type DaemonPtyCwdClass
} from '../../shared/daemon-adoption-telemetry'
import type { EventProps } from '../../shared/telemetry-events'
import { track } from '../telemetry/client'
import {
  probeFolderAccessForFreshDaemon,
  type FreshDaemonFolderAccess
} from './daemon-folder-access-probe'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'

/** Long enough that a focus-time poll cannot spin up a child per poll, short enough to feel live. */
const PROBE_REFRESH_INTERVAL_MS = 5_000

/**
 * What the renderer is allowed to see: an opaque per-daemon scope, the folder class, and whether a
 * restart alone is the remedy. `restartWillHelp === null` means the probe could not answer.
 */
export type DaemonFolderAccessMismatchNotice = {
  daemonScope: string
  cwdClass: DaemonPtyCwdClass
  restartWillHelp: boolean | null
}

type StoredMismatch = DaemonFolderAccessMismatchNotice & {
  daemonKey: string
  canonicalPath: string
  observedAtMs: number
  probedAtMs: number | null
}

let stored: StoredMismatch | null = null
let probeInFlight: Promise<void> | null = null
/** The denial a restart was last offered for; held past the restart so its outcome can be counted. */
let priorDenial: { daemonKey: string; cwdClass: DaemonPtyCwdClass } | null = null
const scopesReported = new Set<string>()

function emit(
  action: EventProps<'daemon_folder_access_notice'>['action'],
  cwdClass: DaemonPtyCwdClass
): void {
  try {
    track('daemon_folder_access_notice', { action, cwd_class: cwdClass })
  } catch {
    // Telemetry is best-effort; a dropped event must never withhold or delay the notice.
  }
}

function daemonKeyOf(identity: DaemonEndpointIdentity): string {
  return `${identity.pid}:${identity.startedAtMs}:${identity.launchNonce}`
}

/** Digest, never a path: the scope only has to tell two daemons apart inside one app session. */
function daemonScopeOf(daemonKey: string): string {
  return createHash('sha256').update(daemonKey).digest('hex').slice(0, 16)
}

/** Only `ok` proves a fresh daemon would get in; every non-verdict stays `null`, never `false`. */
function restartWillHelpFrom(outcome: FreshDaemonFolderAccess): boolean | null {
  if (outcome === 'ok') {
    return true
  }
  return outcome === 'denied' ? false : null
}

async function probeStoredEntry(entry: StoredMismatch): Promise<void> {
  const outcome = await probeFolderAccessForFreshDaemon(entry.canonicalPath)
  // Why the identity compare: a later spawn may have replaced the entry while the child ran.
  if (stored !== entry) {
    return
  }
  stored = { ...entry, restartWillHelp: restartWillHelpFrom(outcome), probedAtMs: Date.now() }
}

function startProbe(entry: StoredMismatch): Promise<void> {
  const run = probeStoredEntry(entry).catch(() => {})
  probeInFlight = run
  void run.then(() => {
    if (probeInFlight === run) {
      probeInFlight = null
    }
  })
  return run
}

/**
 * The restart's verdict: the first spawn by a *different* daemon into the folder class the previous
 * one was denied on. Counted once, so a session reports at most one outcome per restart offered.
 */
function reportRestartOutcome(
  daemonKey: string,
  cwdClass: DaemonPtyCwdClass,
  fixed: boolean
): void {
  if (!priorDenial || priorDenial.daemonKey === daemonKey || priorDenial.cwdClass !== cwdClass) {
    return
  }
  priorDenial = null
  emit(fixed ? 'restart_outcome_fixed' : 'restart_outcome_still_denied', cwdClass)
}

export function recordDaemonFolderAccessMismatch(
  identity: DaemonEndpointIdentity | null,
  cwd: string
): void {
  if (!identity) {
    return
  }
  const daemonKey = daemonKeyOf(identity)
  const cwdClass = classifyDaemonPtyCwd(cwd, homedir())
  reportRestartOutcome(daemonKey, cwdClass, false)
  priorDenial = { daemonKey, cwdClass }
  stored = {
    daemonKey,
    daemonScope: daemonScopeOf(daemonKey),
    cwdClass,
    canonicalPath: cwd,
    observedAtMs: Date.now(),
    restartWillHelp: null,
    probedAtMs: null
  }
  // Why fire-and-forget: this sits on the PTY spawn path, which may never wait on a child probe.
  void startProbe(stored)
}

/**
 * A later spawn this daemon could read retires its own evidence, but only for the same folder
 * class: TCC denies Documents as a whole, so a readable `~/code` says nothing about it.
 */
export function clearDaemonFolderAccessMismatch(
  identity: DaemonEndpointIdentity | null,
  cwd: string
): void {
  if (!identity) {
    return
  }
  const daemonKey = daemonKeyOf(identity)
  const cwdClass = classifyDaemonPtyCwd(cwd, homedir())
  reportRestartOutcome(daemonKey, cwdClass, true)
  if (stored?.daemonKey === daemonKey && stored.cwdClass === cwdClass) {
    stored = null
  }
}

/**
 * Re-runs the probe so step 1 of the fix dialog can complete itself: the user allows Orca in System
 * Settings, returns to the app, and the focus-time poll is the only thing that can notice. A
 * settled `true` is final, and a probe younger than the interval is reused.
 */
export async function refreshDaemonFolderAccessProbe(
  identity: DaemonEndpointIdentity | null,
  options?: { force?: boolean }
): Promise<void> {
  const force = options?.force === true
  // A probe started before the remedy ran cannot see its effect, and its late write would be
  // discarded anyway; let it land, then probe whatever entry it leaves behind.
  if (force && probeInFlight) {
    await probeInFlight
  }
  const entry = stored
  if (!identity || !entry || entry.daemonKey !== daemonKeyOf(identity)) {
    return
  }
  if (entry.restartWillHelp === true) {
    return
  }
  if (
    !force &&
    entry.probedAtMs !== null &&
    Date.now() - entry.probedAtMs < PROBE_REFRESH_INTERVAL_MS
  ) {
    return
  }
  await (force ? startProbe(entry) : (probeInFlight ?? startProbe(entry)))
}

/**
 * The folder the stored evidence is about, for remedies that must act on it. Deliberately narrow:
 * the canonical path is the one field the notice itself must never carry off the main process.
 */
export function getDaemonFolderAccessTarget(
  identity: DaemonEndpointIdentity | null
): { canonicalPath: string; cwdClass: DaemonPtyCwdClass } | null {
  if (!identity || !stored || stored.daemonKey !== daemonKeyOf(identity)) {
    return null
  }
  return { canonicalPath: stored.canonicalPath, cwdClass: stored.cwdClass }
}

/**
 * Returns evidence only while it still belongs to the daemon in use, and emits `shown` the first
 * time a given scope leaves main — the renderer therefore needs no telemetry plumbing for it.
 */
export function getDaemonFolderAccessMismatch(
  currentIdentity: DaemonEndpointIdentity | null
): DaemonFolderAccessMismatchNotice | null {
  if (!currentIdentity || !stored || stored.daemonKey !== daemonKeyOf(currentIdentity)) {
    return null
  }
  const notice = {
    daemonScope: stored.daemonScope,
    cwdClass: stored.cwdClass,
    restartWillHelp: stored.restartWillHelp
  }
  if (!scopesReported.has(notice.daemonScope)) {
    scopesReported.add(notice.daemonScope)
    emit('shown', notice.cwdClass)
  }
  return notice
}

export function resetDaemonFolderAccessMismatchForTests(): void {
  stored = null
  probeInFlight = null
  priorDenial = null
  scopesReported.clear()
}
