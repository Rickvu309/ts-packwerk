import path from "node:path"

export type GlobRequest = { readonly specifier: string; readonly offset: number }

type Node = { readonly type?: unknown; readonly [key: string]: unknown }

type Pattern = { readonly text: string; readonly start: number }

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null

const isGlobCall = (node: Node): boolean => {
  if (node.type !== "CallExpression" || !isNode(node.callee)) return false
  const { object, property, computed } = node.callee
  return (
    node.callee.type === "MemberExpression" &&
    computed === false &&
    isNode(object) &&
    object.type === "MetaProperty" &&
    isNode(property) &&
    property.name === "glob"
  )
}

const patternOf = (node: unknown): Pattern | undefined => {
  if (!isNode(node) || typeof node.start !== "number") return undefined
  if (node.type === "Literal" && typeof node.value === "string") return { text: node.value, start: node.start }
  if (node.type !== "TemplateLiteral" || !Array.isArray(node.expressions) || node.expressions.length > 0)
    return undefined
  const quasi: unknown = Array.isArray(node.quasis) ? node.quasis[0] : undefined
  const cooked = isNode(quasi) && isNode(quasi.value) ? quasi.value.cooked : undefined
  return typeof cooked === "string" ? { text: cooked, start: node.start } : undefined
}

const patternsOf = (argument: unknown): Pattern[] | undefined => {
  if (!isNode(argument) || argument.type !== "ArrayExpression") {
    const single = patternOf(argument)
    return single === undefined ? undefined : [single]
  }
  const elements = Array.isArray(argument.elements) ? argument.elements.map(patternOf) : []
  return elements.every((item) => item !== undefined) ? elements : undefined
}

const globCalls = (root: unknown): Pattern[][] => {
  const calls: Pattern[][] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!isNode(value)) return
    if (isGlobCall(value) && Array.isArray(value.arguments)) {
      const patterns = patternsOf(value.arguments[0])
      if (patterns !== undefined) calls.push(patterns)
    }
    for (const key in value) if (key !== "type") visit(value[key])
  }
  visit(root)
  return calls
}

const fromRoot = (directory: string, pattern: string): string | undefined => {
  if (!pattern.startsWith("./") && !pattern.startsWith("../")) return undefined
  const joined = path.posix.normalize(path.posix.join(directory, pattern))
  return joined.startsWith("../") ? undefined : joined
}

const specifierFor = (directory: string, target: string): string => {
  const relative = path.posix.relative(directory, target)
  return relative.startsWith("../") ? relative : `./${relative}`
}

const matchesOf = (file: string, patterns: readonly Pattern[], files: readonly string[]): GlobRequest[] => {
  const directory = path.posix.dirname(file)
  const rooted = (text: string) => fromRoot(directory, text)
  const negated = patterns.flatMap((item) => {
    const glob = item.text.startsWith("!") ? rooted(item.text.slice(1)) : undefined
    return glob === undefined ? [] : [glob]
  })
  const positive = patterns.flatMap((item) => {
    const glob = item.text.startsWith("!") ? undefined : rooted(item.text)
    return glob === undefined ? [] : [{ glob, start: item.start }]
  })
  return files.flatMap((candidate) => {
    if (candidate === file || negated.some((glob) => path.posix.matchesGlob(candidate, glob))) return []
    const match = positive.find((item) => path.posix.matchesGlob(candidate, item.glob))
    return match === undefined ? [] : [{ specifier: specifierFor(directory, candidate), offset: match.start }]
  })
}

export const globRequestsIn = (
  file: string,
  source: string,
  program: () => unknown,
  files: readonly string[],
): GlobRequest[] =>
  source.includes("import.meta.glob")
    ? globCalls(program()).flatMap((patterns) => matchesOf(file, patterns, files))
    : []
