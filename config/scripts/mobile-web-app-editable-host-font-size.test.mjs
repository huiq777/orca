/**
 * The editable-host rule, over the tree it ships against and over fixtures of its own.
 *
 * Two halves, because an offender list is only evidence when the walk read something. The first
 * runs the rule over the rich Markdown editor's real modules and says which line carries the size;
 * the second drives the readings the real tree does not have — a size below the floor, a name that
 * merely spells the seam's, an editable with no id — against a fixture tree whose only reason to
 * exist is that those readings have to be observable somewhere.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  editableHostFontSizeOffenders,
  editableHostsIn,
  unresolvedEditableHostStyles
} from './mobile-web-app-editable-host-font-size.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile', import.meta.url))

/** The editor's own two modules, as a closure naming nothing else. */
const EDITOR_CLOSURE = {
  local: [
    'src/components/rich-markdown/document-markup.ts',
    'src/components/rich-markdown/document-style.ts'
  ]
}

/** The seam's web half, copied into a fixture tree so the floor is read rather than restated. */
const SEAM_SOURCE = `export const TEXT_INPUT_FONT_SIZE_FLOOR = 16\n`

let fixtureDir = null

/** A fixture tree with the seam in it, plus whatever markup and stylesheet a case needs. */
async function fixture(name, markup, style) {
  const root = join(fixtureDir, name)
  await mkdir(join(root, 'src/platform'), { recursive: true })
  await mkdir(join(root, 'src/doc'), { recursive: true })
  await writeFile(join(root, 'src/platform/text-input-font-size.web.ts'), SEAM_SOURCE, 'utf8')
  await writeFile(join(root, 'src/doc/markup.ts'), markup, 'utf8')
  await writeFile(join(root, 'src/doc/style.ts'), style, 'utf8')
  return { root, closure: { local: ['src/doc/markup.ts', 'src/doc/style.ts'] } }
}

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'orca-editable-host-'))
})

afterAll(async () => {
  if (fixtureDir) {
    await rm(fixtureDir, { recursive: true, force: true })
  }
})

describe('the editable-host font-size rule', () => {
  it('finds the editor the TextInput census cannot see', () => {
    // The precondition every verdict below needs: this walk reads the editor's real markup and
    // names the surface the page mounts.
    expect(editableHostsIn(mobileDir, EDITOR_CLOSURE)).toEqual([
      { file: 'src/components/rich-markdown/document-markup.ts', id: 'editor' }
    ])
  })

  it('follows the surface to the rule in the stylesheet beside it', () => {
    expect(unresolvedEditableHostStyles(mobileDir, EDITOR_CLOSURE)).toEqual([])
    expect(editableHostFontSizeOffenders(mobileDir, EDITOR_CLOSURE)).toEqual([])
  })

  it('reds on an editable under the floor', async () => {
    const { root, closure } = await fixture(
      'under',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 14px;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(root, closure)).toEqual(['src/doc/style.ts:2'])
  })

  it('accepts a literal that already clears the floor, and a size read from the seam', async () => {
    const literal = await fixture(
      'literal',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 18px;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(literal.root, literal.closure)).toEqual([])

    const bound = await fixture(
      'bound',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      "import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'\n" +
        'export function style() {\n  return `    #editor {\n      font-size: ${TEXT_INPUT_FONT_SIZE}px;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(bound.root, bound.closure)).toEqual([])
  })

  it('refuses a name that only spells the seam’s', async () => {
    // A local `const TEXT_INPUT_FONT_SIZE = 14` two lines up is exactly the regression the seam
    // exists to stop, wearing its name.
    const { root, closure } = await fixture(
      'local',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'const TEXT_INPUT_FONT_SIZE = 14\n' +
        'export function style() {\n  return `    #editor {\n      font-size: ${TEXT_INPUT_FONT_SIZE}px;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(root, closure)).toEqual(['src/doc/style.ts:3'])
  })

  it('reports an editable it cannot judge rather than passing it', async () => {
    const noId = await fixture(
      'no-id',
      'export const MARKUP = \'<main contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    main { font-size: 18px; }`\n}\n'
    )
    expect(unresolvedEditableHostStyles(noId.root, noId.closure)).toEqual(['src/doc/markup.ts'])
    expect(editableHostFontSizeOffenders(noId.root, noId.closure)).toEqual([])

    const noRule = await fixture(
      'no-rule',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    main { font-size: 18px; }`\n}\n'
    )
    expect(unresolvedEditableHostStyles(noRule.root, noRule.closure)).toEqual([
      'src/doc/markup.ts (#editor)'
    ])
  })

  it('passes an editable that declares no size, because it inherits one', async () => {
    const { root, closure } = await fixture(
      'inherits',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      padding: 8px;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(root, closure)).toEqual([])
    expect(unresolvedEditableHostStyles(root, closure)).toEqual([])
  })
})
