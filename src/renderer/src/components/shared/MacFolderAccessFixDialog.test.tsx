// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { trackTelemetry, restart, openSettings, resetFolderAccess } = vi.hoisted(() => ({
  trackTelemetry: vi.fn(),
  restart: vi.fn(async () => ({ success: true })),
  openSettings: vi.fn(async () => {}),
  resetFolderAccess: vi.fn()
}))

vi.mock('@/lib/telemetry', () => ({ track: trackTelemetry }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (match, name: string) => options?.[name] ?? match)
}))

import { MacFolderAccessFixDialog } from './MacFolderAccessFixDialog'
import { useMacFolderAccessFixStore } from '@/store/mac-folder-access-fix'

function openWith(restartWillHelp: boolean | null): void {
  useMacFolderAccessFixStore.setState({
    open: true,
    mismatch: { daemonScope: 'aaaa111122223333', cwdClass: 'documents', restartWillHelp }
  })
}

function restartButton(): HTMLElement {
  return screen.getByRole('button', { name: /^Restart/ })
}

function resetButton(): HTMLElement {
  return screen.getByRole('button', { name: /^Reset/ })
}

/** The verdict a forced re-probe returned after the reset ran. */
function probed(restartWillHelp: boolean | null): void {
  resetFolderAccess.mockResolvedValue({
    outcome: 'probed',
    mismatch: { daemonScope: 'aaaa111122223333', cwdClass: 'documents', restartWillHelp }
  })
}

function footerButton(name: string): HTMLElement {
  const footer = screen.getByRole('dialog').querySelector('[data-slot="dialog-footer"]')
  if (!(footer instanceof HTMLElement)) {
    throw new Error('dialog footer did not render')
  }
  return within(footer).getByRole('button', { name })
}

beforeEach(() => {
  trackTelemetry.mockReset()
  restart.mockReset().mockResolvedValue({ success: true })
  openSettings.mockReset().mockResolvedValue(undefined)
  resetFolderAccess.mockReset()
  probed(false)
  useMacFolderAccessFixStore.setState({ open: false, mismatch: null, restartedScope: null })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      pty: { management: { restart, resetFolderAccess } },
      developerPermissions: { openSettings }
    }
  })
})

afterEach(() => {
  cleanup()
})

describe('MacFolderAccessFixDialog', () => {
  it('renders nothing until the toast raises it', () => {
    render(<MacFolderAccessFixDialog />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names the denied folder and leads with the cause', () => {
    openWith(true)
    render(<MacFolderAccessFixDialog />)

    expect(screen.getByText('Fix access to your Documents folder')).toBeTruthy()
    expect(
      screen.getByText('macOS is blocking Orca’s terminal service from this folder.')
    ).toBeTruthy()
    expect(screen.getByText('Open terminals and agents will restart.')).toBeTruthy()
  })

  // restartWillHelp === true means a daemon forked now could already read the folder.
  it('hides step one and enables Restart when the grant is already in place', () => {
    openWith(true)
    render(<MacFolderAccessFixDialog />)

    expect(screen.queryByRole('button', { name: 'Open System Settings' })).toBeNull()
    expect(restartButton().hasAttribute('disabled')).toBe(false)
  })

  it('offers the reset and System Settings when a fresh daemon is still denied', () => {
    openWith(false)
    render(<MacFolderAccessFixDialog />)

    expect(footerButton('Open System Settings')).toBeTruthy()
    expect(footerButton('Reset permission')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Restart/ })).toBeNull()
    expect(screen.getByText('macOS will ask you to allow Orca again.')).toBeTruthy()
  })

  // An unanswered probe must not accuse the user of a missing grant, but the pane stays reachable.
  it('keeps both actions and says so when the probe could not answer', () => {
    openWith(null)
    render(<MacFolderAccessFixDialog />)

    expect(footerButton('Open System Settings')).toBeTruthy()
    expect(restartButton().hasAttribute('disabled')).toBe(false)
    expect(screen.getByText('Couldn’t verify. Skip if already allowed.')).toBeTruthy()
  })

  it('flips step one to done when a later poll reports the grant landed', async () => {
    openWith(false)
    render(<MacFolderAccessFixDialog />)
    expect(screen.queryByRole('button', { name: /^Restart/ })).toBeNull()

    act(() => {
      useMacFolderAccessFixStore.getState().observeMismatch({
        daemonScope: 'aaaa111122223333',
        cwdClass: 'documents',
        restartWillHelp: true
      })
    })

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Open System Settings' })).toBeNull()
    })
    expect(restartButton().hasAttribute('disabled')).toBe(false)
  })

  it('opens the Files and Folders pane through the permission opener', async () => {
    openWith(false)
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(screen.getByRole('button', { name: 'Open System Settings' }))

    expect(openSettings).toHaveBeenCalledWith({ id: 'files-and-folders' })
    expect(trackTelemetry).toHaveBeenCalledWith('daemon_folder_access_notice', {
      action: 'settings_opened',
      cwd_class: 'documents'
    })
  })

  it('restarts the terminal service without a second confirmation', async () => {
    openWith(true)
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(restartButton())

    expect(restart).toHaveBeenCalledTimes(1)
    expect(trackTelemetry).toHaveBeenCalledWith('daemon_folder_access_notice', {
      action: 'restart_clicked',
      cwd_class: 'documents'
    })
  })

  it('shows a busy state while the restart runs', async () => {
    let release: (value: { success: boolean }) => void = () => {}
    restart.mockReturnValue(
      new Promise<{ success: boolean }>((resolve) => {
        release = resolve
      })
    )
    openWith(true)
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(restartButton())

    expect(screen.getByRole('button', { name: /Restarting/ }).hasAttribute('disabled')).toBe(true)
    await act(async () => {
      release({ success: true })
    })
  })

  it('checks off both steps, offers Done, and hands the toast to the notice hook', async () => {
    openWith(true)
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(restartButton())

    await waitFor(() => {
      expect(footerButton('Done')).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: /^Restart/ })).toBeNull()
    expect(screen.getByRole('dialog').querySelectorAll('.text-status-success')).toHaveLength(2)
    expect(useMacFolderAccessFixStore.getState().restartedScope).toBe('aaaa111122223333')
  })

  it('reports a refused restart inline and leaves the button usable', async () => {
    restart.mockResolvedValue({ success: false })
    openWith(true)
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(restartButton())

    await waitFor(() => {
      expect(
        screen.getByText('Restart failed. Try again from Settings → Terminal → Manage Sessions.')
      ).toBeTruthy()
    })
    expect(restartButton().hasAttribute('disabled')).toBe(false)
    expect(useMacFolderAccessFixStore.getState().restartedScope).toBeNull()
  })

  it('reports a rejected restart the same way', async () => {
    restart.mockRejectedValue(new Error('ipc gone'))
    openWith(true)
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(restartButton())

    await waitFor(() => {
      expect(
        screen.getByText('Restart failed. Try again from Settings → Terminal → Manage Sessions.')
      ).toBeTruthy()
    })
    expect(restartButton().hasAttribute('disabled')).toBe(false)
  })

  it('reports the reset click and flips to Restart once the re-probe allows it', async () => {
    probed(true)
    openWith(false)
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(resetButton())

    await waitFor(() => {
      expect(restartButton()).toBeTruthy()
    })
    expect(resetFolderAccess).toHaveBeenCalledTimes(1)
    expect(trackTelemetry).toHaveBeenCalledWith('daemon_folder_access_notice', {
      action: 'reset_clicked',
      cwd_class: 'documents'
    })
    expect(screen.queryByText('Still blocked after the reset.')).toBeNull()
  })

  it('says so when the re-probe still reports a denial', async () => {
    probed(false)
    openWith(false)
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(resetButton())

    await waitFor(() => {
      expect(screen.getByText('Still blocked after the reset.')).toBeTruthy()
    })
    expect(footerButton('Reset permission').hasAttribute('disabled')).toBe(false)
  })

  // An unanswered re-probe is not evidence the reset worked, so the line stays up.
  it('keeps the still-blocked line when the reset returns no verdict', async () => {
    resetFolderAccess.mockResolvedValue({ outcome: 'probed', mismatch: null })
    openWith(false)
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(resetButton())

    await waitFor(() => {
      expect(screen.getByText('Still blocked after the reset.')).toBeTruthy()
    })
  })

  it.each([['reset_failed'], ['unsupported']])(
    'points at System Settings when the reset comes back %s',
    async (outcome) => {
      resetFolderAccess.mockResolvedValue({ outcome })
      openWith(false)
      render(<MacFolderAccessFixDialog />)

      await userEvent.click(resetButton())

      await waitFor(() => {
        expect(
          screen.getByText('Couldn’t reset the permission. Use System Settings instead.')
        ).toBeTruthy()
      })
      expect(screen.queryByText('Still blocked after the reset.')).toBeNull()
    }
  )

  it('reports a rejected reset the same way', async () => {
    resetFolderAccess.mockRejectedValue(new Error('ipc gone'))
    openWith(false)
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(resetButton())

    await waitFor(() => {
      expect(
        screen.getByText('Couldn’t reset the permission. Use System Settings instead.')
      ).toBeTruthy()
    })
  })

  it('blocks every way out while the reset runs', async () => {
    let release: (value: { outcome: string }) => void = () => {}
    resetFolderAccess.mockReturnValue(
      new Promise<{ outcome: string }>((resolve) => {
        release = resolve
      })
    )
    openWith(false)
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(resetButton())

    expect(screen.getByRole('button', { name: /Resetting/ }).hasAttribute('disabled')).toBe(true)
    expect(footerButton('Open System Settings').hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    await userEvent.keyboard('{Escape}')
    expect(useMacFolderAccessFixStore.getState().open).toBe(true)

    await act(async () => {
      release({ outcome: 'unsupported' })
    })
  })

  it('closes on Cancel', async () => {
    openWith(true)
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(footerButton('Cancel'))

    expect(useMacFolderAccessFixStore.getState().open).toBe(false)
  })
})
