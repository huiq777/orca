// Shared state between the folder-access toast (which raises it) and the fix dialog (which renders
// it), so neither has to own the other. STA-7948.

import { toast } from 'sonner'
import { create } from 'zustand'
import type { PtyManagementFolderAccessMismatch } from '../../../preload/api-types'

export const FOLDER_ACCESS_MISMATCH_NOTICE_ID = 'mac-daemon-folder-access-mismatch'

type MacFolderAccessFixState = {
  /** The latest verdict main reported, whatever scope it is about. The dialog renders this one. */
  mismatch: PtyManagementFolderAccessMismatch | null
  /**
   * The scope the user asked to fix. The dialog shows only while it still matches the evidence, so
   * evidence that moves to another scope closes it rather than retargeting it mid-remedy.
   */
  openScope: string | null
  /** The scope whose toast is on screen, and the scopes that may never raise one again. */
  visibleScope: string | null
  dismissedScopes: ReadonlySet<string>
  openFix: () => void
  close: () => void
  /** Every verdict main produces — a poll or a reset's forced re-probe — lands here unconditionally. */
  applyVerdict: (mismatch: PtyManagementFolderAccessMismatch | null) => void
  showNotice: (daemonScope: string) => void
  /** Anyone but the user taking the toast down — a restart, or a poll that read no daemon. */
  retireNotice: (daemonScope: string) => void
  /** The user's own close, which keeps the scope quiet for the rest of the session. */
  dismissNotice: (daemonScope: string) => void
}

export const useMacFolderAccessFixStore = create<MacFolderAccessFixState>()((set, get) => ({
  mismatch: null,
  openScope: null,
  visibleScope: null,
  dismissedScopes: new Set<string>(),
  openFix: () => set((state) => ({ openScope: state.mismatch?.daemonScope ?? null })),
  close: () => set({ openScope: null }),
  applyVerdict: (mismatch) => set({ mismatch }),
  showNotice: (daemonScope) => set({ visibleScope: daemonScope }),
  retireNotice: (daemonScope) => {
    if (get().visibleScope !== daemonScope) {
      return
    }
    // Why clear first: sonner reports a programmatic dismissal through `onDismiss` too, and only
    // a still-visible scope there is the user's doing.
    set({ visibleScope: null })
    toast.dismiss(FOLDER_ACCESS_MISMATCH_NOTICE_ID)
  },
  dismissNotice: (daemonScope) =>
    set((state) => ({
      visibleScope: null,
      dismissedScopes: new Set(state.dismissedScopes).add(daemonScope)
    }))
}))
