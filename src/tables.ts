import { parseSync } from "oxc-parser"
import { lineStarts, position } from "./positions.ts"

export type TableUse = {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly table: string
}

type Walked = { type?: unknown; start?: unknown; end?: unknown }

const stringSpans = (node: unknown, spans: [number, number][]): void => {
  if (Array.isArray(node)) {
    for (const item of node) stringSpans(item, spans)
    return
  }
  if (typeof node !== "object" || node === null) return
  const walked = node as Walked
  const isString =
    walked.type === "TemplateElement" ||
    (walked.type === "Literal" && typeof (node as { value?: unknown }).value === "string")
  if (isString && typeof walked.start === "number" && typeof walked.end === "number")
    spans.push([walked.start, walked.end])
  for (const value of Object.values(node)) stringSpans(value, spans)
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const tableUsesIn = (file: string, source: string, tables: readonly string[]): TableUse[] => {
  const named = tables.filter((table) => source.includes(table))
  if (named.length === 0) return []
  const spans: [number, number][] = []
  stringSpans(parseSync(file, source).program, spans)
  const pattern = new RegExp(`(?<![\\w.])(${named.map(escaped).join("|")})(?![\\w])`, "g")
  const starts = lineStarts(source)
  const uses: TableUse[] = []
  for (const [start, end] of spans) {
    for (const match of source.slice(start, end).matchAll(pattern)) {
      uses.push({ file, ...position(starts, start + match.index), table: match[1] ?? "" })
    }
  }
  return uses
}
