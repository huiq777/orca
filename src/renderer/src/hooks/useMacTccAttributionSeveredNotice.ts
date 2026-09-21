import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type {
  PtyManagementFolderAccessMismatch,
  PtyManagementMacTccAttributionHealth
} from '../../../preload/api-types'
import { isPluginUiLanguage } from '../../../shared/ui-language'
import { useAppStore } from '@/store'
import { usePluginLanguagePackStore } from '@/store/plugin-language-packs'
import { translate } from '@/i18n/i18n'
import { track } from '@/lib/telemetry'
import { resolveUiLocale } from '@/i18n/supported-languages'
import { MANAGE_SESSIONS_SECTION_ID } from '@/components/settings/TerminalTccAttributionNotice'
import { macFolderAccessFolderName } from '@/components/shared/mac-folder-access-folder-name'
import {
  FOLDER_ACCESS_MISMATCH_NOTICE_ID,
  useMacFolderAccessFixStore
} from '@/store/mac-folder-access-fix'

const SEVERED_TCC_NOTICE_ID = 'mac-tcc-attribution-severed'

/** Surface the existing restart remedy when daemon TCC attribution is severed or a folder is denied. */
export function useMacTccAttributionSeveredNotice(): void {
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const setSettingsSearchQuery = useAppStore((s) => s.setSettingsSearchQuery)
  const openFix = useMacFolderAccessFixStore((s) => s.openFix)
  const observeMismatch = useMacFolderAccessFixStore((s) => s.observeMismatch)
  const restartedScope = useMacFolderAccessFixStore((s) => s.restartedScope)
  const uiLanguage = useAppStore((s) => s.settings?.uiLanguage ?? null)
  const pluginLanguagePacks = usePluginLanguagePackStore((s) => s.packs)
  const pluginLanguagePacksLoaded = usePluginLanguagePackStore((s) => s.loaded)
  const { i18n } = useTranslation()
  const selectedPluginLanguage = pluginLanguagePacks.find((pack) => pack.id === uiLanguage)
  const targetLocale =
    uiLanguage === null || (isPluginUiLanguage(uiLanguage) && !pluginLanguagePacksLoaded)
      ? null
      : (selectedPluginLanguage?.resourceLanguage ??
        (isPluginUiLanguage(uiLanguage) ? 'en' : resolveUiLocale(uiLanguage)))
  const localeReady =
    targetLocale !== null &&
    i18n.language === targetLocale &&
    i18n.hasResourceBundle(targetLocale, 'translation')
  const toastedThisSession = useRef(false)
  // Why: toast was only marked after await; a focus/effect re-run mid-check could dual-toast.
  const checkInFlight = useRef(false)
  // Scope latches the folder notice to the daemon that earned it: a restart mints a new scope,
  // so the remedy can be offered again, while a dismissed scope stays dismissed this session.
  const folderScopesShown = useRef(new Set<string>())
  const visibleFolderScope = useRef<string | null>(null)

  // The fix dialog restarted this daemon: retire its toast before the next poll would.
  useEffect(() => {
    if (restartedScope && visibleFolderScope.current === restartedScope) {
      visibleFolderScope.current = null
      toast.dismiss(FOLDER_ACCESS_MISMATCH_NOTICE_ID)
    }
  }, [restartedScope])

  useEffect(() => {
    if (
      !localeReady ||
      typeof window === 'undefined' ||
      window.api?.platform?.get().platform !== 'darwin'
    ) {
      return
    }
    const macTccAttribution = window.api?.pty?.management?.macTccAttribution
    if (!macTccAttribution) {
      return
    }

    const openManageSessions = (): void => {
      setSettingsSearchQuery('')
      openSettingsTarget({
        pane: 'terminal',
        repoId: null,
        sectionId: MANAGE_SESSIONS_SECTION_ID
      })
      openSettingsPage()
    }

    const applySeveredNotice = (health: PtyManagementMacTccAttributionHealth): void => {
      if (health !== 'severed') {
        if (toastedThisSession.current) {
          toast.dismiss(SEVERED_TCC_NOTICE_ID)
        }
        return
      }
      if (toastedThisSession.current) {
        return
      }
      toastedThisSession.current = true
      toast.warning(
        translate(
          'auto.hooks.useMacTccAttributionSeveredNotice.title',
          'macOS permissions may not reach Orca terminals'
        ),
        {
          id: SEVERED_TCC_NOTICE_ID,
          description: translate(
            'auto.hooks.useMacTccAttributionSeveredNotice.description',
            'Running Orca terminals are hosted by a daemon started by a previous Orca installation. macOS may not apply Orca’s Accessibility, Automation, or protected-file permissions to them. Restart the daemon from Manage Sessions to restore access. This will close all running Orca terminals.'
          ),
          duration: Infinity,
          action: {
            label: translate(
              'auto.hooks.useMacTccAttributionSeveredNotice.openManageSessions',
              'Open Manage Sessions'
            ),
            onClick: openManageSessions
          },
          cancel: {
            label: translate('auto.hooks.useMacTccAttributionSeveredNotice.dismiss', 'Dismiss'),
            onClick: () => {}
          }
        }
      )
    }

    const applyFolderAccessNotice = (mismatch: PtyManagementFolderAccessMismatch | null): void => {
      // Why unconditionally: an open dialog's first step completes only when a later poll says so.
      observeMismatch(mismatch)
      if (!mismatch) {
        if (visibleFolderScope.current) {
          // Why forget the scope: main reads a null daemon identity during any reconnect blip and
          // reports it as "no mismatch". If the same daemon comes back denied, it must show again;
          // only a user's "Not now" keeps a scope latched.
          folderScopesShown.current.delete(visibleFolderScope.current)
          visibleFolderScope.current = null
          toast.dismiss(FOLDER_ACCESS_MISMATCH_NOTICE_ID)
        }
        return
      }
      if (folderScopesShown.current.has(mismatch.daemonScope)) {
        return
      }
      folderScopesShown.current.add(mismatch.daemonScope)
      visibleFolderScope.current = mismatch.daemonScope
      // Why here and not in main: this latch, not the IPC read, is what decides a scope is shown.
      track('daemon_folder_access_notice', { action: 'shown', cwd_class: mismatch.cwdClass })
      toast.warning(
        translate(
          'auto.hooks.useMacTccAttributionSeveredNotice.folderAccessTitle',
          'Terminals can’t read your {{folder}}',
          { folder: macFolderAccessFolderName(mismatch.cwdClass) }
        ),
        {
          id: FOLDER_ACCESS_MISMATCH_NOTICE_ID,
          description: translate(
            'auto.hooks.useMacTccAttributionSeveredNotice.folderAccessDescription',
            'macOS is blocking Orca’s terminal service from this folder, so commands run there may fail until it’s fixed.'
          ),
          duration: Infinity,
          action: {
            label: translate('auto.hooks.useMacTccAttributionSeveredNotice.folderAccessFix', 'Fix'),
            onClick: () => {
              track('daemon_folder_access_notice', {
                action: 'fix_opened',
                cwd_class: mismatch.cwdClass
              })
              openFix(mismatch)
            }
          },
          // Why onDismiss, no cancel button: every other toast dismisses through the X alone.
          // Sonner also fires it for toast.dismiss(), so a scope already cleared is not the user.
          onDismiss: () => {
            if (visibleFolderScope.current !== mismatch.daemonScope) {
              return
            }
            visibleFolderScope.current = null
            track('daemon_folder_access_notice', {
              action: 'dismissed',
              cwd_class: mismatch.cwdClass
            })
          }
        }
      )
    }

    const maybeToast = async (): Promise<void> => {
      if (checkInFlight.current) {
        return
      }
      checkInFlight.current = true
      try {
        const { health, folderAccessMismatch } = await macTccAttribution()
        applySeveredNotice(health)
        applyFolderAccessNotice(folderAccessMismatch ?? null)
      } catch {
        // Rejection clears the guard so a later focus can retry.
      } finally {
        checkInFlight.current = false
      }
    }

    void maybeToast()
    const onFocus = (): void => {
      void maybeToast()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [
    localeReady,
    observeMismatch,
    openFix,
    openSettingsPage,
    openSettingsTarget,
    setSettingsSearchQuery
  ])
}
