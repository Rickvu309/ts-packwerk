import { existsSync } from "node:fs"
import path from "node:path"
import { findings } from "./rules.ts"
import { judge, readTodos } from "./todo.ts"
import { configFile, fileWorkspace } from "./workspace.ts"

type Place = { readonly line: number; readonly column: number }

export type LintContext = {
  readonly filename?: string
  readonly sourceCode?: { readonly text: string }
  readonly getFilename?: () => string
  report(problem: { readonly loc: { readonly start: Place; readonly end: Place }; readonly message: string }): void
}

const rootOf = (file: string): string | undefined => {
  let directory = path.dirname(file)
  for (;;) {
    if (existsSync(path.join(directory, configFile))) return directory
    const parent = path.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

export const boundaries = {
  meta: {
    type: "problem",
    docs: { description: "Report imports that break ts-packwerk pack rules, as ts-packwerk check does." },
  },
  create(context: LintContext): { Program?: () => void } {
    const filename = path.resolve(context.filename ?? context.getFilename?.() ?? "")
    const root = rootOf(filename)
    if (root === undefined) return {}
    const file = path.relative(root, filename).split(path.sep).join("/")
    return {
      Program() {
        const workspace = fileWorkspace(root, file, context.sourceCode?.text)
        if (workspace.problems.length > 0) return
        const own = findings(workspace).filter((finding) => finding.file === file && finding.rule !== "cycle")
        for (const finding of judge(own, readTodos(root, workspace.packs)).fresh) {
          const start = { line: finding.line, column: finding.column - 1 }
          context.report({ loc: { start, end: start }, message: `${finding.rule}: ${finding.message}` })
        }
      },
    }
  },
}

export const plugin: {
  readonly meta: { readonly name: string }
  readonly rules: { readonly boundaries: typeof boundaries }
} = {
  meta: { name: "ts-packwerk" },
  rules: { boundaries },
}

export default plugin
