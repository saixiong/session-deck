import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The webview must render from VS Code's theme tokens alone. A hard-coded
 * colour is invisible in the author's theme and wrong in every other one, so
 * this guard makes it a test failure instead of a bug report.
 */
describe('webview/styles.css theme contract', () => {
  const css = readFileSync(resolve(__dirname, '../../webview/styles.css'), 'utf8')
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')

  it('contains no colour literals', () => {
    const literals = withoutComments.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g) ?? []
    expect(literals).toEqual([])
  })

  it('only references --vscode-* or --deck-* custom properties', () => {
    const vars = withoutComments.match(/var\(\s*(--[a-zA-Z0-9-]+)/g) ?? []
    const foreign = vars
      .map((v) => v.replace(/var\(\s*/, ''))
      .filter((v) => !/^--(vscode|deck)-/.test(v))
    expect(foreign).toEqual([])
  })

  it('paints the body background explicitly so the host theme cannot bleed through', () => {
    expect(withoutComments).toMatch(/body\s*\{[^}]*background:\s*var\(--vscode-editor-background\)/)
  })
})
