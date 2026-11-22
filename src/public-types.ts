import { parseSync } from "oxc-parser"
import { lineStarts, position } from "./positions.ts"

export type TypeGap = {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly name: string
}

type Node = { readonly type?: string; readonly start?: number; readonly [key: string]: unknown }

const typed = (param: unknown): boolean => {
  const node = param as Node
  if (node.type === "AssignmentPattern") return typed(node.left) || node.typeAnnotation !== undefined
  if (node.type === "TSParameterProperty") return typed(node.parameter)
  return node.typeAnnotation !== undefined && node.typeAnnotation !== null
}

const plainValue = (init: unknown): boolean => {
  const node = init as Node | undefined
  if (node === undefined || node === null) return true
  if (node.type === "Literal") return true
  if (node.type === "TemplateLiteral") return (node.expressions as unknown[]).length === 0
  if (node.type === "UnaryExpression") return plainValue(node.argument)
  if (node.type === "TSAsExpression" || node.type === "TSTypeAssertion") return true
  if (node.type === "TSSatisfiesExpression") return plainValue(node.expression)
  if (node.type === "ObjectExpression") {
    return (node.properties as Node[]).every(
      (property) => property.type === "Property" && property.computed !== true && plainValue(property.value),
    )
  }
  if (node.type === "ArrayExpression") {
    return (node.elements as Node[]).every(
      (element) => element !== null && element.type !== "SpreadElement" && plainValue(element),
    )
  }
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    return node.returnType !== undefined && node.returnType !== null && (node.params as unknown[]).every(typed)
  }
  return false
}

export const typeGapsIn = (file: string, source: string): TypeGap[] => {
  const starts = lineStarts(source)
  const gaps: TypeGap[] = []
  const gap = (node: Node, name: string) => gaps.push({ file, ...position(starts, node.start ?? 0), name })
  const fn = (node: Node, name: string) => {
    if (node.returnType === undefined || node.returnType === null) gap(node, name)
    else if (!(node.params as unknown[]).every(typed)) gap(node, `${name} parameters`)
  }
  for (const statement of (parseSync(file, source).program as unknown as { body: Node[] }).body) {
    const declaration = (statement.type === "ExportNamedDeclaration" ? statement.declaration : undefined) as
      | Node
      | undefined
    if (declaration?.type === "FunctionDeclaration")
      fn(declaration, String((declaration.id as Node | null)?.name ?? "function"))
    if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations as Node[]) {
        const id = item.id as Node
        if (id.typeAnnotation === undefined || id.typeAnnotation === null) {
          if (!plainValue(item.init)) gap(item, String(id.name ?? "binding"))
        }
      }
    }
    if (statement.type === "ExportDefaultDeclaration") {
      const value = statement.declaration as Node
      if (value.type === "FunctionDeclaration") fn(value, "default")
      else if (value.type !== "ClassDeclaration" && value.type !== "TSInterfaceDeclaration" && !plainValue(value))
        gap(value, "default")
    }
  }
  return gaps
}
