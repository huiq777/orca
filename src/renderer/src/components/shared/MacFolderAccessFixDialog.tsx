import React, { useCallback, useState } from 'react'
import { CircleCheck, CircleDashed, LoaderCircle } from 'lucide-react'
import type { PtyManagementFolderAccessMismatch } from '../../../../preload/api-types'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { track } from '@/lib/telemetry'
import { useMacFolderAccessFixStore } from '@/store/mac-folder-access-fix'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { macFolderAccessFolderName } from './mac-folder-access-folder-name'

const FILES_AND_FOLDERS_PANE = { id: 'files-and-folders' } as const

type RestartState = 'idle' | 'busy' | 'done' | 'failed'

function Step({
  done,
  label,
  helper
}: {
  done: boolean
  label: string
  helper?: string
}): React.JSX.Element {
  return (
    <li className="flex items-start gap-2">
      {done ? (
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-status-success" aria-hidden="true" />
      ) : (
        <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm text-foreground">{label}</span>
        {helper ? <span className="text-xs text-muted-foreground">{helper}</span> : null}
      </div>
    </li>
  )
}

// No instruction for a toggle that is already on: nothing has been verified to fix that case yet
// (STA-7948), so the step claims only what the probe knows.
function allowStepHelper(mismatch: PtyManagementFolderAccessMismatch): string | undefined {
  // A probe that could not answer must not accuse the user of a missing grant.
  if (mismatch.restartWillHelp === null) {
    return translate(
      'auto.components.shared.MacFolderAccessFixDialog.stepAllowUnknown',
      'Couldn’t verify. Skip if already allowed.'
    )
  }
  return undefined
}

function FixSteps({
  mismatch,
  restartState
}: {
  mismatch: PtyManagementFolderAccessMismatch
  restartState: RestartState
}): React.JSX.Element {
  return (
    <>
      <ol className="flex flex-col gap-3">
        <Step
          done={mismatch.restartWillHelp === true || restartState === 'done'}
          label={translate(
            'auto.components.shared.MacFolderAccessFixDialog.stepAllow',
            'Allow Orca under Files and Folders'
          )}
          helper={allowStepHelper(mismatch)}
        />
        <Step
          done={restartState === 'done'}
          label={translate(
            'auto.components.shared.MacFolderAccessFixDialog.stepRestart',
            'Restart Orca’s terminal service'
          )}
          helper={translate(
            'auto.components.shared.MacFolderAccessFixDialog.restartConsequence',
            'Open terminals and agents will restart.'
          )}
        />
      </ol>
      {restartState === 'failed' ? (
        <p className="text-sm text-destructive">
          {translate(
            'auto.components.shared.MacFolderAccessFixDialog.restartFailed',
            'Restart failed. Try again from Settings → Terminal → Manage Sessions.'
          )}
        </p>
      ) : null}
    </>
  )
}

/** The footer carries the active step's one action, so the steps stay a checklist. */
function FixFooter({
  mismatch,
  restartState,
  onCancel,
  onOpenSettings,
  onRestart
}: {
  mismatch: PtyManagementFolderAccessMismatch
  restartState: RestartState
  onCancel: () => void
  onOpenSettings: () => void
  onRestart: () => void
}): React.JSX.Element {
  const busy = restartState === 'busy'
  const openSettingsLabel = translate(
    'auto.components.shared.MacFolderAccessFixDialog.openSystemSettings',
    'Open System Settings'
  )
  if (restartState === 'done') {
    return (
      <Button size="sm" onClick={onCancel}>
        {translate('auto.components.shared.MacFolderAccessFixDialog.done', 'Done')}
      </Button>
    )
  }
  if (mismatch.restartWillHelp === false) {
    return (
      <>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {translate('auto.components.shared.MacFolderAccessFixDialog.cancel', 'Cancel')}
        </Button>
        <Button size="sm" onClick={onOpenSettings}>
          {openSettingsLabel}
        </Button>
      </>
    )
  }
  return (
    <>
      {mismatch.restartWillHelp === null ? (
        <Button variant="ghost" size="sm" onClick={onOpenSettings} disabled={busy}>
          {openSettingsLabel}
        </Button>
      ) : (
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {translate('auto.components.shared.MacFolderAccessFixDialog.cancel', 'Cancel')}
        </Button>
      )}
      <Button size="sm" onClick={onRestart} disabled={busy}>
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
        {busy
          ? translate('auto.components.shared.MacFolderAccessFixDialog.restarting', 'Restarting…')
          : translate('auto.components.shared.MacFolderAccessFixDialog.restart', 'Restart')}
      </Button>
    </>
  )
}

/**
 * The remedy for a daemon macOS refuses a folder to (STA-7948), raised from the folder-access
 * toast. Two steps, because a restart alone only works once Orca itself is allowed again — which
 * step 1 does, and the focus-time poll behind `restartWillHelp` is what notices it landed.
 */
export function MacFolderAccessFixDialog(): React.JSX.Element | null {
  const open = useMacFolderAccessFixStore((s) => s.open)
  const mismatch = useMacFolderAccessFixStore((s) => s.mismatch)
  const close = useMacFolderAccessFixStore((s) => s.close)
  const markRestarted = useMacFolderAccessFixStore((s) => s.markRestarted)
  const [restartState, setRestartState] = useState<RestartState>('idle')
  const mountedRef = useMountedRef()
  const cwdClass = mismatch?.cwdClass ?? null

  const onOpenSettings = useCallback((): void => {
    if (cwdClass) {
      track('daemon_folder_access_notice', { action: 'settings_opened', cwd_class: cwdClass })
    }
    void window.api?.developerPermissions?.openSettings(FILES_AND_FOLDERS_PANE)
  }, [cwdClass])

  const onRestart = useCallback(async (): Promise<void> => {
    if (cwdClass) {
      track('daemon_folder_access_notice', { action: 'restart_clicked', cwd_class: cwdClass })
    }
    setRestartState('busy')
    try {
      const { success } = await window.api.pty.management.restart()
      if (!mountedRef.current) {
        return
      }
      setRestartState(success ? 'done' : 'failed')
      if (success && mismatch) {
        // Why via the store: the replaced daemon's identity is gone, so the poll that raised the
        // toast will never mention it again; the notice hook retires it without logging a dismiss.
        markRestarted(mismatch.daemonScope)
      }
    } catch {
      if (mountedRef.current) {
        setRestartState('failed')
      }
    }
  }, [cwdClass, markRestarted, mismatch, mountedRef])

  if (!mismatch) {
    return null
  }
  const folder = macFolderAccessFolderName(mismatch.cwdClass)
  const busy = restartState === 'busy'
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) {
          close()
        }
      }}
    >
      <DialogContent
        className="max-w-md"
        showCloseButton={!busy}
        onPointerDownOutside={(event) => {
          if (busy) {
            event.preventDefault()
          }
        }}
        onEscapeKeyDown={(event) => {
          if (busy) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.shared.MacFolderAccessFixDialog.title',
              'Fix access to your {{folder}}',
              { folder }
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.shared.MacFolderAccessFixDialog.lead',
              'macOS is blocking Orca’s terminal service from this folder.'
            )}
          </DialogDescription>
        </DialogHeader>
        <FixSteps mismatch={mismatch} restartState={restartState} />
        <DialogFooter>
          <FixFooter
            mismatch={mismatch}
            restartState={restartState}
            onCancel={close}
            onOpenSettings={onOpenSettings}
            onRestart={() => void onRestart()}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
