import { isPublic, manifestFile, packageRootOf, packOf, type Pack, type Workspace } from "./workspace.ts"

export type RuleName = "dependency" | "privacy" | "interface" | "layer" | "table" | "public_type" | "package" | "cycle"

export type Finding = {
  readonly rule: RuleName
  readonly file: string
  readonly line: number
  readonly column: number
  readonly fromPack: string
  readonly toPack: string
  readonly target: string
  readonly message: string
}

export const todoRules: ReadonlySet<RuleName> = new Set([
  "dependency",
  "privacy",
  "interface",
  "layer",
  "table",
  "public_type",
])

const crossPack = (workspace: Workspace) =>
  workspace.references.flatMap((reference) => {
    if (reference.target.kind !== "file") return []
    const from = packOf(workspace.packs, reference.file)
    const to = packOf(workspace.packs, reference.target.file)
    if (from === undefined || to === undefined || from === to) return []
    return [{ reference, target: reference.target.file, from, to }]
  })

const rank = (workspace: Workspace, pack: Pack): number =>
  pack.layer === undefined ? -1 : workspace.config.layers.indexOf(pack.layer)

const packFindings = (workspace: Workspace): Finding[] =>
  crossPack(workspace).flatMap(({ reference, target, from, to }) => {
    const at = {
      file: reference.file,
      line: reference.line,
      column: reference.column,
      fromPack: from.name,
      toPack: to.name,
      target,
    }
    const found: Finding[] = []
    const samePackage =
      packageRootOf(workspace.packageRoots, reference.file) === packageRootOf(workspace.packageRoots, target)
    if (samePackage && from.enforceDependencies && !from.dependencies.includes(to.name)) {
      found.push({
        ...at,
        rule: "dependency",
        message: `${from.name} uses ${to.name} (${target}) but does not list it in dependencies; add it to ${from.name}/pack.yml if it should`,
      })
    }
    if (to.enforcePrivacy && !isPublic(to, target)) {
      found.push({
        ...at,
        rule: "privacy",
        message: `${target} is private to ${to.name}; import a public path (${to.publicPaths.join(", ") || "none yet"}) or add this file to its public list`,
      })
    }
    const faces = from.interfaceDependencies.get(to.name)
    if (faces !== undefined && isPublic(to, target)) {
      const allowed = faces.flatMap((face) => to.interfaces.get(face) ?? [])
      if (!allowed.some((entry) => target === entry || target.startsWith(`${entry.replace(/\/$/, "")}/`))) {
        found.push({
          ...at,
          rule: "interface",
          message: `${from.name} may use only ${faces.map((face) => `${to.name}#${face}`).join(", ")}, and ${target} is outside it`,
        })
      }
    }
    const fromRank = rank(workspace, from)
    const toRank = rank(workspace, to)
    if (from.enforceLayers && fromRank >= 0 && toRank >= 0 && toRank < fromRank) {
      found.push({
        ...at,
        rule: "layer",
        message: `${from.name} (layer ${from.layer}) may not use ${to.name} (layer ${to.layer}), a higher layer; move what it needs into a pack at layer ${from.layer} or lower`,
      })
    }
    return found
  })

const pathFindings = (workspace: Workspace): Finding[] =>
  workspace.references.flatMap((reference) => {
    const target = reference.target
    if (target.kind !== "file" || !reference.specifier.startsWith(".")) return []
    const fromRoot = packageRootOf(workspace.packageRoots, reference.file)
    const toRoot = packageRootOf(workspace.packageRoots, target.file)
    if (fromRoot === undefined || toRoot === undefined || fromRoot === toRoot) return []
    return [
      {
        rule: "package",
        file: reference.file,
        line: reference.line,
        column: reference.column,
        fromPack: packOf(workspace.packs, reference.file)?.name ?? ".",
        toPack: toRoot,
        target: target.file,
        message: `${reference.specifier} reaches into ${toRoot} by path; import it by its package name`,
      },
    ]
  })

const packageFindings = (workspace: Workspace): Finding[] =>
  workspace.references.flatMap((reference) => {
    const target = reference.target
    const declared = target.kind === "package" || target.kind === "file" ? target.declared : undefined
    if (declared === undefined || declared === "runtime") return []
    if (declared === "dev" && reference.typeOnly) return []
    const name =
      target.kind === "package"
        ? target.name
        : reference.specifier
            .split("/")
            .slice(0, reference.specifier.startsWith("@") ? 2 : 1)
            .join("/")
    const from = packOf(workspace.packs, reference.file)
    return [
      {
        rule: "package",
        file: reference.file,
        line: reference.line,
        column: reference.column,
        fromPack: from?.name ?? ".",
        toPack: name,
        target: name,
        message:
          declared === "dev"
            ? `${name} is a devDependency but runs here; move it to dependencies`
            : `${name} is not in the nearest package.json`,
      },
    ]
  })

const tableFindings = (workspace: Workspace): Finding[] => {
  const owners = new Map(workspace.packs.flatMap((pack) => pack.ownsTables.map((table) => [table, pack.name] as const)))
  return workspace.tableUses.flatMap((use) => {
    const owner = owners.get(use.table)
    const from = packOf(workspace.packs, use.file)?.name ?? "."
    if (owner === undefined || owner === from) return []
    return [
      {
        rule: "table",
        file: use.file,
        line: use.line,
        column: use.column,
        fromPack: from,
        toPack: owner,
        target: use.table,
        message: `${use.table} belongs to ${owner}; read and write it through ${owner}'s public functions`,
      },
    ]
  })
}

const publicTypeFindings = (workspace: Workspace): Finding[] =>
  workspace.typeGaps.map((gap) => {
    const pack = packOf(workspace.packs, gap.file)?.name ?? "."
    return {
      rule: "public_type",
      file: gap.file,
      line: gap.line,
      column: gap.column,
      fromPack: pack,
      toPack: pack,
      target: gap.name,
      message: `${gap.name} is public in ${pack}; write its type, so a change inside cannot change what callers see`,
    }
  })

const stronglyConnected = (nodes: readonly string[], next: (node: string) => readonly string[]): string[][] => {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const components: string[][] = []
  let counter = 0
  const visit = (name: string): void => {
    index.set(name, counter)
    low.set(name, counter)
    counter += 1
    stack.push(name)
    onStack.add(name)
    for (const other of next(name)) {
      if (!index.has(other)) {
        visit(other)
        low.set(name, Math.min(low.get(name) ?? 0, low.get(other) ?? 0))
      } else if (onStack.has(other)) {
        low.set(name, Math.min(low.get(name) ?? 0, index.get(other) ?? 0))
      }
    }
    if (low.get(name) !== index.get(name)) return
    const component: string[] = []
    let member: string | undefined
    do {
      member = stack.pop()
      if (member === undefined) break
      onStack.delete(member)
      component.push(member)
    } while (member !== name)
    components.push(component.sort())
  }
  for (const node of nodes) if (!index.has(node)) visit(node)
  return components.sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""))
}

export const dependencyCycles = (packs: readonly Pack[]): string[][] => {
  const byName = new Map(packs.map((pack) => [pack.name, pack]))
  const next = (name: string) => (byName.get(name)?.dependencies ?? []).filter((other) => byName.has(other))
  return stronglyConnected(
    packs.map((pack) => pack.name),
    next,
  ).filter((component) => component.length > 1 || next(component[0] ?? "").includes(component[0] ?? ""))
}

export type Loop = {
  readonly packs: readonly string[]
  readonly undeclared: readonly (readonly [from: string, to: string])[]
}

const samePackageUses = (workspace: Workspace): Map<string, Set<string>> => {
  const edges = new Map<string, Set<string>>()
  for (const { reference, target, from, to } of crossPack(workspace)) {
    if (packageRootOf(workspace.packageRoots, reference.file) !== packageRootOf(workspace.packageRoots, target))
      continue
    edges.set(from.name, (edges.get(from.name) ?? new Set()).add(to.name))
  }
  return edges
}

export const referenceLoops = (workspace: Workspace): Loop[] => {
  const edges = samePackageUses(workspace)
  const declared = new Map(workspace.packs.map((pack) => [pack.name, new Set(pack.dependencies)]))
  return stronglyConnected([...edges.keys()].sort(), (name) => [...(edges.get(name) ?? [])].sort()).flatMap((packs) => {
    const members = new Set(packs)
    const undeclared = packs.flatMap((from) =>
      [...(edges.get(from) ?? [])]
        .filter((to) => members.has(to) && declared.get(from)?.has(to) !== true)
        .sort()
        .map((to) => [from, to] as const),
    )
    return packs.length > 1 && undeclared.length > 0 ? [{ packs, undeclared }] : []
  })
}

const cycleFindings = (workspace: Workspace): Finding[] =>
  dependencyCycles(workspace.packs).map((cycle) => {
    const first = cycle[0] ?? "."
    return {
      rule: "cycle",
      file: first === "." ? manifestFile : `${first}/${manifestFile}`,
      line: 1,
      column: 1,
      fromPack: first,
      toPack: cycle.at(-1) ?? first,
      target: cycle.join(" -> "),
      message: `dependencies form a cycle: ${[...cycle, first].join(" -> ")}`,
    }
  })

const order = (left: Finding, right: Finding): number =>
  left.file.localeCompare(right.file) ||
  left.line - right.line ||
  left.column - right.column ||
  left.rule.localeCompare(right.rule)

export const findings = (workspace: Workspace): Finding[] =>
  [
    ...cycleFindings(workspace),
    ...packFindings(workspace),
    ...tableFindings(workspace),
    ...publicTypeFindings(workspace),
    ...pathFindings(workspace),
    ...packageFindings(workspace),
  ].sort(order)
