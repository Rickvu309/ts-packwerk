import { existsSync, globSync, readFileSync } from "node:fs"
import path from "node:path"
import { parse, parseSync, type EcmaScriptModule } from "oxc-parser"
import { ResolverFactory, type ResolveResult } from "oxc-resolver"
import { exportTarget } from "./package-exports.ts"
import { lineStarts, position } from "./positions.ts"
import { typeGapsIn, type TypeGap } from "./public-types.ts"
import { tableUsesIn, type TableUse } from "./tables.ts"

import {
  configFile,
  manifestFile,
  posix,
  readConfig,
  readPack,
  skipDirectory,
  type Config,
  type Pack,
} from "./manifests.ts"

export { configFile, manifestFile, readConfig, type Config, type Pack }
export const todoFile = "pack_todo.yml"

type Declared = "runtime" | "dev" | "missing"

export type Target =
  | { readonly kind: "file"; readonly file: string; readonly declared?: Declared }
  | { readonly kind: "package"; readonly name: string; readonly declared: Declared }
  | { readonly kind: "builtin" }
  | { readonly kind: "unresolved"; readonly reason: string }

export type Reference = {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly specifier: string
  readonly typeOnly: boolean
  readonly reexport: boolean
  readonly target: Target
}

export type Workspace = {
  readonly root: string
  readonly config: Config
  readonly packs: readonly Pack[]
  readonly files: readonly string[]
  readonly references: readonly Reference[]
  readonly packageRoots: readonly string[]
  readonly tableUses: readonly TableUse[]
  readonly typeGaps: readonly TypeGap[]
  readonly problems: readonly string[]
}

export const packOf = (packs: readonly Pack[], file: string): Pack | undefined => {
  let owner: Pack | undefined
  for (const pack of packs) {
    const inside = pack.name === "." || file === pack.name || file.startsWith(`${pack.name}/`)
    if (inside && (owner === undefined || pack.name.length > owner.name.length || owner.name === ".")) owner = pack
  }
  return owner
}

export const packageRootOf = (packageRoots: readonly string[], file: string): string | undefined => {
  let owner: string | undefined
  for (const root of packageRoots) {
    const inside = root === "." || file.startsWith(`${root}/`)
    if (inside && (owner === undefined || owner === "." || root.length > owner.length)) owner = root
  }
  return owner
}

export const isPublic = (pack: Pack, file: string): boolean =>
  pack.publicPaths.some((entry) => file === entry || file.startsWith(`${entry.replace(/\/$/, "")}/`))

type Request = { specifier: string; offset: number; typeOnly: boolean; reexport: boolean }

const literal = /^\s*(["'`])([^"'`$\\]*)\1\s*$/

const requestsFrom = (module: EcmaScriptModule, source: string): Request[] => {
  const requests: Request[] = module.staticImports.map((item) => ({
    specifier: item.moduleRequest.value,
    offset: item.moduleRequest.start,
    typeOnly: item.entries.length > 0 && item.entries.every((entry) => entry.isType),
    reexport: false,
  }))
  for (const item of module.staticExports) {
    const reexports = item.entries.filter((entry) => entry.moduleRequest !== null)
    const first = reexports[0]?.moduleRequest
    if (first === undefined || first === null) continue
    requests.push({
      specifier: first.value,
      offset: first.start,
      typeOnly: reexports.every((entry) => entry.isType),
      reexport: true,
    })
  }
  for (const item of module.dynamicImports) {
    const text = literal.exec(source.slice(item.moduleRequest.start, item.moduleRequest.end))
    if (text?.[2] !== undefined)
      requests.push({ specifier: text[2], offset: item.moduleRequest.start, typeOnly: false, reexport: false })
  }
  return requests
}

const jsonc = (text: string): string =>
  text
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match, quoted: string | undefined) => quoted ?? "")
    .replace(/,(\s*[}\]])/g, "$1")

const packageNameOf = (specifier: string): string => {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier)
}

const isBare = (specifier: string): boolean =>
  !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("#") && !/^[a-z]+:/.test(specifier)

type Manifest = { directory: string; name: string | undefined; runtime: Set<string>; dev: Set<string> }

const extensionSwaps: Record<string, readonly string[]> = {
  ".js": [".ts", ".tsx", ".js"],
  ".jsx": [".tsx", ".jsx"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
  ".d.ts": [".ts", ".tsx"],
}

export const openSetup = (root: string) => {
  const problems: string[] = []
  const config = readConfig(root, problems)
  const manifests = globSync(`**/${manifestFile}`, { cwd: root, exclude: (entry) => skipDirectory(entry) })
  const packs = manifests
    .map((manifest) => readPack(root, path.join(root, manifest), config, problems))
    .sort((left, right) => left.name.localeCompare(right.name))
  const names = new Set(packs.map((pack) => pack.name))
  const byName = new Map(packs.map((pack) => [pack.name, pack]))
  for (const pack of packs) {
    for (const [other, faces] of pack.interfaceDependencies) {
      for (const face of faces) {
        if (byName.get(other)?.interfaces.has(face) === false) {
          problems.push(
            `${pack.name}/${manifestFile} depends on ${other}#${face}, which is not one of its public interfaces`,
          )
        }
      }
    }
  }
  const tableOwners = new Map<string, string>()
  for (const pack of packs) {
    for (const table of pack.ownsTables) {
      const other = tableOwners.get(table)
      if (other !== undefined) problems.push(`${table} is owned by both ${other} and ${pack.name}`)
      tableOwners.set(table, pack.name)
    }
  }
  const tables = [...tableOwners.keys()]
  for (const pack of packs) {
    for (const dependency of pack.dependencies) {
      if (!names.has(dependency))
        problems.push(`${pack.name}/${manifestFile} depends on ${dependency}, which is not a pack`)
    }
  }

  const files = globSync([...config.include], { cwd: root, exclude: (entry) => skipDirectory(path.basename(entry)) })
    .map(posix)
    .filter((file) => !config.exclude.some((pattern) => path.matchesGlob(file, pattern)))
    .sort()
  const fileSet = new Set(files)

  const manifestsByDirectory = new Map<string, Manifest | undefined>()
  const nearestManifest = (directory: string): Manifest | undefined => {
    if (manifestsByDirectory.has(directory)) return manifestsByDirectory.get(directory)
    const file = path.join(directory, "package.json")
    let found: Manifest | undefined
    if (existsSync(file)) {
      const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
      const keys = (field: string) => Object.keys((json[field] as Record<string, string> | undefined) ?? {})
      found = {
        directory: posix(path.relative(root, directory)) || ".",
        name: typeof json.name === "string" ? json.name : undefined,
        runtime: new Set([...keys("dependencies"), ...keys("peerDependencies"), ...keys("optionalDependencies")]),
        dev: new Set(keys("devDependencies")),
      }
    } else if (path.dirname(directory) !== directory && directory !== root) {
      found = nearestManifest(path.dirname(directory))
    }
    manifestsByDirectory.set(directory, found)
    return found
  }

  const outputs = new Map<string, { out: string; source: string } | undefined>()
  const buildOutput = (directory: string): { out: string; source: string } | undefined => {
    if (outputs.has(directory)) return outputs.get(directory)
    const tsconfig = path.join(directory, "tsconfig.json")
    let found: { out: string; source: string } | undefined
    if (existsSync(path.join(directory, "package.json"))) {
      if (existsSync(tsconfig)) {
        const options = (
          JSON.parse(jsonc(readFileSync(tsconfig, "utf8"))) as { compilerOptions?: Record<string, unknown> }
        ).compilerOptions
        const out = options?.outDir
        const source = options?.rootDir
        if (typeof out === "string") {
          found = {
            out: path.join(directory, out),
            source: path.join(directory, typeof source === "string" ? source : "."),
          }
        }
      }
    } else if (path.dirname(directory) !== directory && directory !== root) {
      found = buildOutput(path.dirname(directory))
    }
    outputs.set(directory, found)
    return found
  }

  const toSource = (absolute: string): string => {
    const relative = posix(path.relative(root, absolute))
    if (fileSet.has(relative)) return relative
    const build = buildOutput(path.dirname(absolute))
    if (build === undefined || !absolute.startsWith(`${build.out}${path.sep}`)) return relative
    const inside = path.join(build.source, path.relative(build.out, absolute))
    const extension = inside.endsWith(".d.ts") ? ".d.ts" : path.extname(inside)
    const stem = inside.slice(0, inside.length - extension.length)
    for (const swap of extensionSwaps[extension] ?? [extension]) {
      const candidate = posix(path.relative(root, `${stem}${swap}`))
      if (fileSet.has(candidate) || existsSync(`${stem}${swap}`)) return candidate
    }
    return relative
  }

  const resolver = new ResolverFactory({
    tsconfig: "auto",
    conditionNames: ["import", "module", "default"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    extensionAlias: { ".js": [".ts", ".tsx", ".js"], ".jsx": [".tsx", ".jsx"], ".mjs": [".mts", ".mjs"] },
    builtinModules: true,
  })

  const workspacePackages = new Map<string, { directory: string; manifest: Record<string, unknown> }>()
  for (const file of globSync("**/package.json", {
    cwd: root,
    exclude: (entry) => skipDirectory(path.basename(entry)),
  })) {
    const manifest = JSON.parse(readFileSync(path.join(root, file), "utf8")) as Record<string, unknown>
    if (typeof manifest.name === "string")
      workspacePackages.set(manifest.name, { directory: path.join(root, path.dirname(file)), manifest })
  }

  const unbuilt = (specifier: string): string | undefined => {
    const name = packageNameOf(specifier)
    const found = workspacePackages.get(name)
    if (found === undefined) return undefined
    const subpath = `.${specifier.slice(name.length)}`
    const target = exportTarget(found.manifest, subpath)
    return target === undefined ? undefined : toSource(path.join(found.directory, target))
  }

  const declaredIn = (file: string, name: string): Declared => {
    const manifest = nearestManifest(path.dirname(path.join(root, file)))
    if (manifest === undefined || manifest.name === name || manifest.runtime.has(name)) return "runtime"
    return manifest.dev.has(name) ? "dev" : "missing"
  }

  const classify = (file: string, specifier: string, resolved: ResolveResult): Target => {
    if (resolved.builtin !== undefined || specifier.startsWith("node:")) return { kind: "builtin" }
    const bare = isBare(specifier)
    const local = (source: string): Target =>
      bare && workspacePackages.has(packageNameOf(specifier))
        ? { kind: "file", file: source, declared: declaredIn(file, packageNameOf(specifier)) }
        : { kind: "file", file: source }
    if (resolved.path === undefined && bare) {
      const source = unbuilt(specifier)
      if (source !== undefined) return local(source)
    }
    const external = resolved.path === undefined || resolved.path.includes(`${path.sep}node_modules${path.sep}`)
    if (resolved.path !== undefined && !external) return local(toSource(resolved.path))
    if (!bare) return { kind: "unresolved", reason: resolved.error ?? "not found" }
    const name = packageNameOf(specifier)
    return { kind: "package", name, declared: declaredIn(file, name) }
  }

  const targetOf = async (file: string, specifier: string): Promise<Target> =>
    classify(file, specifier, await resolver.resolveFileAsync(path.join(root, file), specifier))

  const targetOfSync = (file: string, specifier: string): Target =>
    classify(file, specifier, resolver.resolveFileSync(path.join(root, file), specifier))

  const ownerOf = (file: string): string | undefined => nearestManifest(path.dirname(path.join(root, file)))?.directory

  const tableUsesOf = (file: string, source: string): TableUse[] =>
    tables.length > 0 && !config.tableExempt.some((pattern) => path.matchesGlob(file, pattern))
      ? tableUsesIn(file, source, tables)
      : []

  const allPackageRoots = [...workspacePackages.values()]
    .map((found) => posix(path.relative(root, found.directory)) || ".")
    .sort()

  return { problems, config, packs, files, fileSet, targetOf, targetOfSync, ownerOf, tableUsesOf, allPackageRoots }
}

const referencesOf = (
  file: string,
  source: string,
  requests: readonly Request[],
  targets: readonly Target[],
): Reference[] => {
  const starts = lineStarts(source)
  return requests.map((request, index) => ({
    file,
    ...position(starts, request.offset),
    specifier: request.specifier,
    typeOnly: request.typeOnly,
    reexport: request.reexport,
    target: targets[index] ?? { kind: "unresolved", reason: "not resolved" },
  }))
}

export const loadWorkspace = async (root: string): Promise<Workspace> => {
  const { problems, config, packs, files, fileSet, targetOf, ownerOf, tableUsesOf } = openSetup(root)
  const packageRoots = new Set<string>()
  const tableUses: TableUse[] = []
  const perFile = await Promise.all(
    files.map(async (file) => {
      const owner = ownerOf(file)
      if (owner !== undefined) packageRoots.add(owner)
      const source = readFileSync(path.join(root, file), "utf8")
      const requests = requestsFrom((await parse(file, source)).module, source)
      tableUses.push(...tableUsesOf(file, source))
      const targets = await Promise.all(requests.map((request) => targetOf(file, request.specifier)))
      return referencesOf(file, source, requests, targets)
    }),
  )

  const references = perFile.flat()
  const typeGaps: TypeGap[] = []
  for (const pack of packs.filter((item) => item.enforcePublicTypes)) {
    const reached = new Set(pack.publicPaths.filter((file) => fileSet.has(file)))
    const queue = [...reached]
    while (queue.length > 0) {
      const file = queue.pop() ?? ""
      for (const reference of references) {
        if (reference.file !== file || !reference.reexport || reference.target.kind !== "file") continue
        const next = reference.target.file
        if (!reached.has(next) && fileSet.has(next) && packOf(packs, next) === pack) {
          reached.add(next)
          queue.push(next)
        }
      }
    }
    for (const file of [...reached].sort())
      typeGaps.push(...typeGapsIn(file, readFileSync(path.join(root, file), "utf8")))
  }
  return {
    root,
    config,
    packs,
    files,
    references,
    packageRoots: [...packageRoots].sort(),
    tableUses,
    typeGaps,
    problems,
  }
}

const setups = new Map<string, ReturnType<typeof openSetup>>()

export const fileWorkspace = (root: string, file: string, text?: string): Workspace => {
  const setup = setups.get(root) ?? openSetup(root)
  setups.set(root, setup)
  const { problems, config, packs, targetOfSync, tableUsesOf, allPackageRoots } = setup
  const source = text ?? readFileSync(path.join(root, file), "utf8")
  const requests = requestsFrom(parseSync(file, source).module, source)
  const targets = requests.map((request) => targetOfSync(file, request.specifier))
  return {
    root,
    config,
    packs,
    files: [file],
    references: referencesOf(file, source, requests, targets),
    packageRoots: allPackageRoots,
    tableUses: tableUsesOf(file, source),
    typeGaps: [],
    problems,
  }
}
