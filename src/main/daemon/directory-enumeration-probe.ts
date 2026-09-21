import { opendirSync, type Dir } from 'node:fs'
import { opendir } from 'node:fs/promises'

/** `denied` is the only outcome that proves a permission refusal; `other` keeps unknown errors apart. */
export type DirectoryEnumerationOutcome = 'ok' | 'denied' | 'missing' | 'other'

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  const { code } = error
  return typeof code === 'string' ? code : undefined
}

function outcomeForError(error: unknown): DirectoryEnumerationOutcome {
  const code = errorCode(error)
  if (code === 'EPERM' || code === 'EACCES') {
    return 'denied'
  }
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'other'
}

/**
 * Why enumeration and not `access()`: macOS TCC can let `access(R_OK|X_OK)` succeed on a protected
 * folder while `opendir` still fails, which is exactly what a shell listing its cwd hits. One entry
 * is enough — the refusal lands on `opendir` or the first read, never later.
 */
export async function enumerateDirectoryOnce(path: string): Promise<DirectoryEnumerationOutcome> {
  let dir: Dir | undefined
  try {
    dir = await opendir(path)
    await dir.read()
    return 'ok'
  } catch (error) {
    return outcomeForError(error)
  } finally {
    await dir?.close().catch(() => {
      // A handle we cannot close says nothing about readability.
    })
  }
}

/**
 * The blocking variant, for a process that has nothing else to serve while it waits. Never call it
 * from the app: on macOS this read is what raises the TCC prompt, and the prompt holds the syscall
 * until the user answers, which would take the event loop down with it for the whole time.
 */
export function enumerateDirectoryOnceSync(path: string): DirectoryEnumerationOutcome {
  let dir: Dir | undefined
  try {
    dir = opendirSync(path)
    dir.readSync()
    return 'ok'
  } catch (error) {
    return outcomeForError(error)
  } finally {
    try {
      dir?.closeSync()
    } catch {
      // A handle we cannot close says nothing about readability.
    }
  }
}
