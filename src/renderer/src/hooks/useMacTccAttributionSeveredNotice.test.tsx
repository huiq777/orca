// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { MacosTccPromptNoticeHost } from './MacosTccPromptNoticeHost'
import { useMacFolderAccessFixStore } from '@/store/mac-folder-access-fix'

type FolderAccessMismatch = {
  daemonScope: string
  cwdClass: string
  restartWillHelp: boolean | null
} | null
type AttributionResult = {
  health: 'intact' | 'severed' | 'unknown'
  folderAccessMismatch: FolderAccessMismatch
}

const macTccAttribution = vi.hoisted(() =>
  vi.fn(async (): Promise<AttributionResult> => ({ health: 'intact', folderAccessMismatch: null }))
)
const trackTelemetry = vi.hoisted(() => vi.fn())
const openSettingsPage = vi.hoisted(() => vi.fn())
const openSettingsTarget = vi.hoisted(() => vi.fn())
const setSettingsSearchQuery = vi.hoisted(() => vi.fn())
const platform = vi.hoisted(() => ({ value: 'darwin' as NodeJS.Platform }))

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: {
      language: 'en',
      hasResourceBundle: () => true
    }
  })
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      openSettingsPage,
      openSettingsTarget,
      setSettingsSearchQuery,
      settings: { uiLanguage: 'en' }
    })
}))

vi.mock('@/store/plugin-language-packs', () => ({
  usePluginLanguagePackStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ packs: [], loaded: true })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (match, name: string) => options?.[name] ?? match)
}))

vi.mock('@/lib/telemetry', () => ({ track: trackTelemetry }))

vi.mock('./useMacosTccPromptNotice', () => ({
  useMacosTccPromptNotice: vi.fn()
}))

describe('useMacTccAttributionSeveredNotice', () => {
  beforeEach(() => {
    macTccAttribution.mockReset()
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: null })
    trackTelemetry.mockReset()
    openSettingsPage.mockReset()
    openSettingsTarget.mockReset()
    setSettingsSearchQuery.mockReset()
    platform.value = 'darwin'
    vi.mocked(toast.warning).mockReset()
    vi.mocked(toast.dismiss).mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        platform: {
          get: () => ({ platform: platform.value })
        },
        pty: {
          management: {
            macTccAttribution
          }
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('does not toast when attribution is intact', async () => {
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalled()
    })
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('does not probe on non-macOS focus', async () => {
    platform.value = 'win32'
    render(<MacosTccPromptNoticeHost />)

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    expect(macTccAttribution).not.toHaveBeenCalled()
  })

  it('toasts Manage Sessions remedy once when attribution is severed', async () => {
    macTccAttribution.mockResolvedValue({ health: 'severed', folderAccessMismatch: null })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1)
    })
    const call = vi.mocked(toast.warning).mock.calls[0]
    const title = String(call?.[0] ?? '')
    const options = call?.[1] as
      | { description?: string; action?: { onClick?: () => void } }
      | undefined
    expect(title).toMatch(/macOS permissions may not reach Orca terminals/i)
    expect(String(options?.description ?? '')).toMatch(/Manage Sessions/i)
    options?.action?.onClick?.()
    expect(setSettingsSearchQuery).toHaveBeenCalledWith('')
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'terminal',
      repoId: null,
      sectionId: 'terminal-manage-sessions'
    })
    expect(openSettingsPage).toHaveBeenCalled()
  })

  it('does not toast again after the first severed notice this session', async () => {
    macTccAttribution.mockResolvedValue({ health: 'severed', folderAccessMismatch: null })
    const { rerender } = render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1)
    })
    rerender(<MacosTccPromptNoticeHost />)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(2)
      expect(toast.warning).toHaveBeenCalledTimes(1)
    })
  })

  it('dismisses the warning after attribution recovers', async () => {
    macTccAttribution.mockResolvedValueOnce({ health: 'severed', folderAccessMismatch: null })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1)
    })
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: null })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(2)
      expect(toast.dismiss).toHaveBeenCalledWith('mac-tcc-attribution-severed')
    })
  })

  it('coalesces overlapping mount/focus checks into one IPC call and one toast', async () => {
    let resolveHealth!: (value: AttributionResult) => void
    const pending = new Promise<AttributionResult>((resolve) => {
      resolveHealth = resolve
    })
    macTccAttribution.mockImplementation(() => pending)

    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(1)
    })
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(macTccAttribution).toHaveBeenCalledTimes(1)
    expect(toast.warning).not.toHaveBeenCalled()

    await act(async () => {
      resolveHealth({ health: 'severed', folderAccessMismatch: null })
      await pending
    })
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(1)
      expect(toast.warning).toHaveBeenCalledTimes(1)
    })
  })

  it('clears the in-flight guard on rejection so a later focus can retry', async () => {
    macTccAttribution
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValueOnce({ health: 'severed', folderAccessMismatch: null })

    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(1)
    })
    expect(toast.warning).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(2)
      expect(toast.warning).toHaveBeenCalledTimes(1)
    })
  })
})

describe('useMacTccAttributionSeveredNotice folder-access notice', () => {
  const SCOPE_A = {
    daemonScope: 'aaaa111122223333',
    cwdClass: 'documents',
    restartWillHelp: true
  }
  const SCOPE_B = {
    daemonScope: 'bbbb444455556666',
    cwdClass: 'desktop',
    restartWillHelp: false
  }

  type ToastOptions = {
    id?: string
    description?: string
    duration?: number
    action?: { label?: string; onClick?: () => void }
    cancel?: { label?: string; onClick?: () => void }
    onDismiss?: () => void
  }

  function shownEvents(): Record<string, unknown>[] {
    return trackTelemetry.mock.calls
      .filter(([name, props]) => name === 'daemon_folder_access_notice' && props.action === 'shown')
      .map(([, props]) => props)
  }

  function folderNoticeCalls(): { title: string; options: ToastOptions }[] {
    return vi
      .mocked(toast.warning)
      .mock.calls.map((call) => ({
        title: String(call[0] ?? ''),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook is the only caller and always passes this options object.
        options: (call[1] ?? {}) as ToastOptions
      }))
      .filter(({ options }) => options.id === 'mac-daemon-folder-access-mismatch')
  }

  beforeEach(() => {
    macTccAttribution.mockReset()
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: null })
    trackTelemetry.mockReset()
    openSettingsPage.mockReset()
    openSettingsTarget.mockReset()
    setSettingsSearchQuery.mockReset()
    platform.value = 'darwin'
    vi.mocked(toast.warning).mockReset()
    vi.mocked(toast.dismiss).mockReset()
    useMacFolderAccessFixStore.setState({ open: false, mismatch: null })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        platform: { get: () => ({ platform: platform.value }) },
        pty: { management: { macTccAttribution } }
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('does not toast when there is no mismatch', async () => {
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalled()
    })
    expect(folderNoticeCalls()).toHaveLength(0)
  })

  it('names the denied folder and the cost, and leaves the steps to the dialog', async () => {
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })

    const notice = folderNoticeCalls()[0]
    expect(notice.title).toMatch(/Terminals can’t read your Documents folder/i)
    // The dialog carries the steps; the toast says what is blocked and what that costs.
    expect(notice.options.description).toMatch(/may fail until it’s fixed/)
    expect(notice.options.description).not.toMatch(/Manage Sessions|System Settings/)
    expect(notice.options.duration).toBe(Infinity)
    expect(notice.options.action?.label).toBe('Fix')
    expect(notice.options.cancel).toBeUndefined()
  })

  it('opens the fix dialog rather than Manage Sessions', async () => {
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })

    act(() => {
      folderNoticeCalls()[0].options.action?.onClick?.()
    })

    expect(useMacFolderAccessFixStore.getState().open).toBe(true)
    expect(useMacFolderAccessFixStore.getState().mismatch).toEqual(SCOPE_A)
    expect(openSettingsPage).not.toHaveBeenCalled()
    expect(trackTelemetry).toHaveBeenCalledWith('daemon_folder_access_notice', {
      action: 'fix_opened',
      cwd_class: 'documents'
    })
  })

  it('carries a later poll’s verdict into the open dialog', async () => {
    macTccAttribution.mockResolvedValueOnce({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })
    act(() => {
      folderNoticeCalls()[0].options.action?.onClick?.()
    })
    macTccAttribution.mockResolvedValue({
      health: 'intact',
      folderAccessMismatch: { ...SCOPE_A, restartWillHelp: false }
    })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => {
      expect(useMacFolderAccessFixStore.getState().mismatch?.restartWillHelp).toBe(false)
    })
  })

  it('leaves the open dialog pointed at its own daemon when another is denied', async () => {
    macTccAttribution.mockResolvedValueOnce({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })
    act(() => {
      folderNoticeCalls()[0].options.action?.onClick?.()
    })
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_B })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(2)
    })

    expect(useMacFolderAccessFixStore.getState().mismatch).toEqual(SCOPE_A)
  })

  it('substitutes the folder word for each protected class', async () => {
    for (const [cwdClass, expected] of [
      ['desktop', 'Desktop folder'],
      ['downloads', 'Downloads folder'],
      ['other-home', 'workspace folder'],
      ['outside-home', 'workspace folder']
    ]) {
      vi.mocked(toast.warning).mockReset()
      macTccAttribution.mockResolvedValue({
        health: 'intact',
        folderAccessMismatch: {
          daemonScope: `scope-${cwdClass}`,
          cwdClass,
          restartWillHelp: true
        }
      })
      render(<MacosTccPromptNoticeHost />)
      await waitFor(() => {
        expect(folderNoticeCalls()).toHaveLength(1)
      })
      expect(folderNoticeCalls()[0].title).toContain(expected)
      cleanup()
    }
  })

  it('shows once per daemon scope, not once per poll', async () => {
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(2)
    })
    expect(folderNoticeCalls()).toHaveLength(1)
    expect(shownEvents()).toHaveLength(1)
  })

  // The notice is shown by the renderer, so the renderer is what can count it.
  it('counts the notice as shown when it raises one, and not when it withholds one', async () => {
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })

    expect(shownEvents()).toEqual([{ action: 'shown', cwd_class: 'documents' }])
  })

  it('never re-shows a scope the user dismissed this session', async () => {
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })

    folderNoticeCalls()[0].options.onDismiss?.()
    expect(trackTelemetry).toHaveBeenCalledWith('daemon_folder_access_notice', {
      action: 'dismissed',
      cwd_class: 'documents'
    })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(macTccAttribution).toHaveBeenCalledTimes(2)
    })
    expect(folderNoticeCalls()).toHaveLength(1)
  })

  // The restart remedy: a replacement daemon mints a new identity, so the poll goes quiet.
  it('dismisses the notice once the poll stops reporting a mismatch', async () => {
    macTccAttribution.mockResolvedValueOnce({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: null })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(toast.dismiss).toHaveBeenCalledWith('mac-daemon-folder-access-mismatch')
    })
  })

  it('re-shows the same daemon after a poll that briefly reported nothing', async () => {
    macTccAttribution.mockResolvedValueOnce({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })
    macTccAttribution.mockResolvedValueOnce({ health: 'intact', folderAccessMismatch: null })
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(toast.dismiss).toHaveBeenCalledWith('mac-daemon-folder-access-mismatch')
    })
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_A })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(2)
    })
  })

  it('shows again when a replacement daemon is denied too', async () => {
    macTccAttribution.mockResolvedValueOnce({ health: 'intact', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(1)
    })
    macTccAttribution.mockResolvedValue({ health: 'intact', folderAccessMismatch: SCOPE_B })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(folderNoticeCalls()).toHaveLength(2)
    })
    expect(folderNoticeCalls()[1].title).toContain('Desktop folder')
  })

  it('raises both notices when attribution is severed and a folder is denied', async () => {
    macTccAttribution.mockResolvedValue({ health: 'severed', folderAccessMismatch: SCOPE_A })
    render(<MacosTccPromptNoticeHost />)
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(2)
    })
    expect(folderNoticeCalls()).toHaveLength(1)
  })
})
