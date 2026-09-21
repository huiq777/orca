/**
 * The 16 px floor for an editable the page styles with CSS rather than with a `TextInput` prop.
 *
 * `mobile-web-app-text-input-font-size-seam.mjs` reads the floor and holds every `TextInput` in a
 * route's closure to it. It cannot see the rich Markdown editor: that surface is a
 * `contenteditable` element in a string of markup, sized by a rule in a stylesheet the same module
 * emits, and the walk there matches JSX `TextInput` tags and `style` props. So the editor shipped
 * at 14 px and was measured at 14 px in both engines — the exact condition the floor exists for,
 * because iOS zooms the page on focus of any editable under 16 px, never zooms back, and
 * `keyboard-occlusion.web.ts` then answers 0 for the rest of the session at a scale other than 1.
 *
 * The rule is over the closure rather than over a list of known editors, for the same reason the
 * `TextInput` one is: the next editable host is the one nobody remembers to add.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { textInputFontSizeFloor } from './mobile-web-app-text-input-font-size-seam.mjs'

/** The seam's export, which is how a size states the floor rather than restating the number. */
const SEAM_EXPORT = 'TEXT_INPUT_FONT_SIZE'

/** `contenteditable="true"` in a markup string, with the id the element carries. */
const EDITABLE_MARKUP =
  /id="([A-Za-z][\w-]*)"[^>]*contenteditable="true"|contenteditable="true"[^>]*id="([A-Za-z][\w-]*)"/g

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Every editable host a closure declares, as `{ file, id }`.
 *
 * The completeness half of the verdict below: an empty offender list is only evidence when the
 * walk found the editables it is judging. A module that plants an editable with no id lands here
 * with `id: null` and is reported as unresolved rather than passing.
 */
export function editableHostsIn(mobileDir, closure) {
  const found = []
  for (const file of closure.local) {
    const source = readOrNull(join(mobileDir, file))
    if (source === null || !source.includes('contenteditable="true"')) {
      continue
    }
    const ids = [...source.matchAll(EDITABLE_MARKUP)].map((match) => match[1] ?? match[2] ?? null)
    if (ids.length === 0) {
      found.push({ file, id: null })
      continue
    }
    for (const id of ids) {
      found.push({ file, id })
    }
  }
  return found.sort((left, right) =>
    left.file === right.file
      ? String(left.id).localeCompare(String(right.id))
      : left.file < right.file
        ? -1
        : 1
  )
}

/**
 * The rule a selector opens in a stylesheet string, with where it opens, or null for none.
 *
 * The selector has to be the whole of a rule's selector, so the character before it is a line
 * start, the end of the rule before it, a comma, or the backtick the template literal opens with.
 * A descendant rule that merely mentions the surface is a different rule and is not this one.
 *
 * Textual, and flat: the sheets this reads have no at-rules and no nesting, which is the same
 * assumption `document-style-scoping.ts` makes and refuses to exceed.
 */
function ruleFor(source, selector) {
  const pattern = new RegExp(
    `(?:^|[},\`])[^\\S\\n]*${selector.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')}\\s*\\{`,
    'm'
  )
  const match = pattern.exec(source)
  if (match === null) {
    return null
  }
  // Counted rather than matched to the first `}`: a declaration reading the seam is written
  // `${TEXT_INPUT_FONT_SIZE}px`, whose own closing brace would have ended the block one
  // declaration early and left the size looking absent.
  const open = match.index + match[0].length
  let depth = 1
  for (let at = open; at < source.length; at += 1) {
    if (source[at] === '{') {
      depth += 1
      continue
    }
    if (source[at] === '}') {
      depth -= 1
      if (depth === 0) {
        return { declarations: source.slice(open, at), index: match.index }
      }
    }
  }
  return null
}

/** What a `font-size` declaration is worth: a literal, a seam substitution, or something else. */
function readFontSize(mobileDir, source, declarations) {
  const match = /font-size:\s*([^;]+);/.exec(declarations)
  if (match === null) {
    // No size of its own, so it inherits, and the floor is about the size an editable declares.
    return { text: null, onSeam: true }
  }
  const text = match[1].trim()
  const literal = /^(\d+(?:\.\d+)?)px$/.exec(text)
  if (literal !== null) {
    return { text, onSeam: Number(literal[1]) >= textInputFontSizeFloor(mobileDir) }
  }
  // A substitution, which is only the seam when this module imported the seam's export: the same
  // name declared locally, or imported from somewhere else, is exactly the regression the seam
  // exists to stop wearing its name.
  const substituted = /^\$\{([A-Za-z_$][\w$]*)\}px$/.exec(text)
  if (substituted === null) {
    return { text, onSeam: false }
  }
  const imported = new RegExp(
    `import\\s*\\{[^}]*\\b${SEAM_EXPORT}\\b[^}]*\\}\\s*from\\s*'[^']*text-input-font-size'`
  )
  return { text, onSeam: substituted[1] === SEAM_EXPORT && imported.test(source) }
}

/**
 * Where each editable host's size is declared, as `{ at, size }`.
 *
 * The size is looked for in the same module the markup came from and in the modules beside it: a
 * document's markup and its stylesheet are two exports of one program, so the rule is stated over
 * that program's own directory rather than over the whole closure.
 */
function editableHostSizes(mobileDir, closure) {
  const resolutions = []
  for (const host of editableHostsIn(mobileDir, closure)) {
    if (host.id === null) {
      resolutions.push({ at: host.file, size: null })
      continue
    }
    const directory = host.file.slice(0, host.file.lastIndexOf('/'))
    const siblings = closure.local.filter((file) => file.startsWith(`${directory}/`))
    let resolved = null
    for (const file of siblings) {
      const source = readOrNull(join(mobileDir, file))
      if (source === null) {
        continue
      }
      const rule = ruleFor(source, `#${host.id}`)
      if (rule === null) {
        continue
      }
      const line = source.slice(0, rule.index).split('\n').length
      resolved = { at: `${file}:${line}`, size: readFontSize(mobileDir, source, rule.declarations) }
      break
    }
    resolutions.push(resolved ?? { at: `${host.file} (#${host.id})`, size: null })
  }
  return resolutions
}

/**
 * Every editable host whose size this walk could not follow to a rule, as it names it.
 *
 * A hole rather than a pass: an editable planted with no id, or one whose selector no stylesheet
 * beside it opens, is a surface the rule cannot judge and has to say so.
 */
export function unresolvedEditableHostStyles(mobileDir, closure) {
  return editableHostSizes(mobileDir, closure)
    .filter((entry) => entry.size === null)
    .map((entry) => entry.at)
    .sort()
}

/** Every editable host in a closure sized below the floor and off the seam, as `path:line`. */
export function editableHostFontSizeOffenders(mobileDir, closure) {
  return [
    ...new Set(
      editableHostSizes(mobileDir, closure)
        .filter((entry) => entry.size !== null && !entry.size.onSeam)
        .map((entry) => entry.at)
    )
  ].sort()
}
