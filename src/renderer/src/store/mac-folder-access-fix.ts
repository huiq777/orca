// Shared state between the folder-access toast (which raises it) and the fix dialog (which renders
// it), so neither has to own the other. STA-7948.

import { toast } from 'sonner'
import { create } from 'zustand'
import type { PtyManagementFolderAccessMismatch } from '../../../preload/api-types'

export const FOLDER_ACCESS_MISMATCH_NOTICE_ID = 'mac-daemon-folder-access-mismatch'

type MacFolderAccessFixState = {
  open: boolean
  mismatch: PtyManagementFolderAccessMismatch | null
  /** The scope whose toast is on screen, and the scopes that may never raise one again. */
  visibleScope: string | null
  dismissedScopes: ReadonlySet<string>
  openFix: (mismatch: PtyManagementFolderAccessMismatch) => void
  close: () => void
  /** Carries a later poll's verdict into an open dialog so its first step can complete itself. */
  applyPollVerdict: (mismatch: PtyManagementFolderAccessMismatch | null) => void
  showNotice: (daemonScope: string) => void
  /** Anyone but the user taking the toast down — a restart, or a poll that read no daemon. */
  retireNotice: (daemonScope: string) => void
  /** The user's own close, which keeps the scope quiet for the rest of the session. */
  dismissNotice: (daemonScope: string) => void
}

export const useMacFolderAccessFixStore = create<MacFolderAccessFixState>()((set, get) => ({
  open: false,
  mismatch: null,
  visibleScope: null,
  dismissedScopes: new Set<string>(),
  openFix: (mismatch) => set({ open: true, mismatch }),
  close: () => set({ open: false }),
  applyPollVerdict: (mismatch) =>
    set((state) =>
      // Why the scope compare: a replacement daemon's denial is a different remedy, and the open
      // dialog must not silently retarget itself onto it.
      mismatch && state.mismatch?.daemonScope === mismatch.daemonScope ? { mismatch } : state
    ),
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
