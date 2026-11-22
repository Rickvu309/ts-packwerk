import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { todoRules, type Finding, type RuleName } from "./rules.ts"
import { todoFile, type Pack } from "./workspace.ts"

export type TodoEntry = {
  readonly toPack: string
  readonly target: string
  readonly rule: RuleName
  readonly file: string
}

export type Todos = ReadonlyMap<string, readonly TodoEntry[]>

export type Verdict = {
  readonly fresh: readonly Finding[]
  readonly listed: readonly Finding[]
  readonly stale: readonly (TodoEntry & { readonly fromPack: string })[]
}

const key = (fromPack: string, entry: { toPack: string; target: string; rule: string; file: string }): string =>
  [fromPack, entry.toPack, entry.target, entry.rule, entry.file].join("\u0000")

const todoPath = (root: string, pack: string): string => path.join(root, pack, todoFile)

type Shape = Record<string, Record<string, { violations?: string[]; files?: string[] }>>

export const readTodos = (root: string, packs: readonly Pack[]): Todos => {
  const todos = new Map<string, TodoEntry[]>()
  for (const pack of packs) {
    const file = todoPath(root, pack.name)
    if (!existsSync(file)) continue
    const shape = (YAML.parse(readFileSync(file, "utf8")) ?? {}) as Shape
    const entries: TodoEntry[] = []
    for (const [toPack, targets] of Object.entries(shape)) {
      for (const [target, listed] of Object.entries(targets ?? {})) {
        for (const rule of listed.violations ?? []) {
          for (const from of listed.files ?? []) entries.push({ toPack, target, rule: rule as RuleName, file: from })
        }
      }
    }
    todos.set(pack.name, entries)
  }
  return todos
}

export const judge = (found: readonly Finding[], todos: Todos): Verdict => {
  const remaining = new Map<string, TodoEntry & { fromPack: string }>()
  for (const [fromPack, entries] of todos) {
    for (const entry of entries) remaining.set(key(fromPack, entry), { ...entry, fromPack })
  }
  const fresh: Finding[] = []
  const listed: Finding[] = []
  const matched = new Set<string>()
  for (const finding of found) {
    const id = key(finding.fromPack, finding)
    if (todoRules.has(finding.rule) && remaining.has(id)) {
      listed.push(finding)
      matched.add(id)
    } else {
      fresh.push(finding)
    }
  }
  const stale = [...remaining].filter(([id]) => !matched.has(id)).map(([, entry]) => entry)
  return { fresh, listed, stale }
}

export const writeTodos = (root: string, packs: readonly Pack[], found: readonly Finding[]): number => {
  const byPack = new Map<string, Shape>()
  let written = 0
  for (const finding of found) {
    if (!todoRules.has(finding.rule)) continue
    const shape = byPack.get(finding.fromPack) ?? {}
    byPack.set(finding.fromPack, shape)
    const targets = (shape[finding.toPack] ??= {})
    const entry = (targets[finding.target] ??= { violations: [], files: [] })
    if (!entry.violations?.includes(finding.rule)) entry.violations?.push(finding.rule)
    if (!entry.files?.includes(finding.file)) entry.files?.push(finding.file)
    written += 1
  }
  for (const pack of packs) {
    const file = todoPath(root, pack.name)
    const shape = byPack.get(pack.name)
    if (shape === undefined) {
      if (existsSync(file)) rmSync(file)
      continue
    }
    const sorted: Shape = {}
    for (const toPack of Object.keys(shape).sort()) {
      const targets = shape[toPack] ?? {}
      const next: Shape[string] = {}
      for (const target of Object.keys(targets).sort()) {
        const entry = targets[target] ?? {}
        next[target] = { violations: [...(entry.violations ?? [])].sort(), files: [...(entry.files ?? [])].sort() }
      }
      sorted[toPack] = next
    }
    writeFileSync(file, YAML.stringify(sorted, { lineWidth: 0 }))
  }
  return written
}
