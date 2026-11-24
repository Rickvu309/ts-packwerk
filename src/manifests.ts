import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import YAML from "yaml"

export const configFile = "packwerk.yml"
export const manifestFile = "pack.yml"

export type Config = {
  readonly include: readonly string[]
  readonly exclude: readonly string[]
  readonly layers: readonly string[]
  readonly tableExempt: readonly string[]
  readonly tests: boolean
  readonly testExempt: readonly string[]
}

export type Pack = {
  readonly name: string
  readonly layer: string | undefined
  readonly enforceDependencies: boolean
  readonly enforcePrivacy: boolean
  readonly enforceLayers: boolean
  readonly dependencies: readonly string[]
  readonly interfaceDependencies: ReadonlyMap<string, readonly string[]>
  readonly publicPaths: readonly string[]
  readonly interfaces: ReadonlyMap<string, readonly string[]>
  readonly enforcePublicTypes: boolean
  readonly ownsTables: readonly string[]
  readonly metadata: Readonly<Record<string, unknown>>
}

const defaultConfig: Config = {
  include: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
  exclude: ["**/node_modules/**", "**/dist/**"],
  layers: [],
  tableExempt: [],
  tests: false,
  testExempt: [],
}

export const isTestPath = (file: string): boolean =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || file.split("/").includes("testing")

const defaultPublic = ["index.ts", "index.tsx", "src/index.ts", "src/index.tsx"]

export const posix = (file: string): string => file.split(path.sep).join("/")

const strings = (value: unknown, where: string, problems: string[]): string[] | undefined => {
  if (value === undefined) return undefined
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value
  problems.push(`${where} must be a list of strings`)
  return undefined
}

const flag = (value: unknown, where: string, problems: string[], fallback: boolean): boolean => {
  if (value === undefined) return fallback
  if (typeof value === "boolean") return value
  problems.push(`${where} must be true or false`)
  return fallback
}

const readYaml = (file: string, problems: string[]): Record<string, unknown> => {
  const parsed: unknown = YAML.parse(readFileSync(file, "utf8")) ?? {}
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  problems.push(`${file} must hold a mapping`)
  return {}
}

export const readConfig = (root: string, problems: string[]): Config => {
  const file = path.join(root, configFile)
  if (!existsSync(file)) return defaultConfig
  const raw = readYaml(file, problems)
  return {
    include: strings(raw.include, `${configFile} include`, problems) ?? defaultConfig.include,
    exclude: [...defaultConfig.exclude, ...(strings(raw.exclude, `${configFile} exclude`, problems) ?? [])],
    layers: strings(raw.layers, `${configFile} layers`, problems) ?? defaultConfig.layers,
    tableExempt: strings(raw.table_exempt, `${configFile} table_exempt`, problems) ?? defaultConfig.tableExempt,
    tests: flag(raw.tests, `${configFile} tests`, problems, false),
    testExempt: strings(raw.test_exempt, `${configFile} test_exempt`, problems) ?? defaultConfig.testExempt,
  }
}

export const skipDirectory = (name: string): boolean => name === "node_modules" || name === "dist" || name === ".git"

export const packName = (root: string, manifest: string): string =>
  posix(path.relative(root, path.dirname(manifest))) || "."

export const readPack = (root: string, manifest: string, config: Config, problems: string[]): Pack => {
  const name = packName(root, manifest)
  const where = `${name}/${manifestFile}`
  const raw = readYaml(manifest, problems)
  const layer = raw.layer
  if (layer !== undefined && (typeof layer !== "string" || !config.layers.includes(layer))) {
    problems.push(`${where} layer ${String(layer)} is not one of ${configFile} layers`)
  }
  const directory = path.dirname(manifest)
  const rooted = (entry: string): string => (name === "." ? posix(entry) : `${name}/${posix(entry)}`)
  const interfaces = new Map<string, string[]>()
  const rawPublic = raw.public
  if (rawPublic === undefined) {
    interfaces.set("default", defaultPublic.filter((entry) => existsSync(path.join(directory, entry))).map(rooted))
  } else if (typeof rawPublic === "object" && rawPublic !== null && !Array.isArray(rawPublic)) {
    for (const [face, entries] of Object.entries(rawPublic)) {
      interfaces.set(face, (strings(entries, `${where} public.${face}`, problems) ?? []).map(rooted))
    }
  } else {
    interfaces.set("default", (strings(rawPublic, `${where} public`, problems) ?? []).map(rooted))
  }
  if (rawPublic !== undefined) {
    for (const entry of [...interfaces.values()].flat()) {
      if (!existsSync(path.join(root, entry))) problems.push(`${where} public path ${entry} does not exist`)
    }
  }
  const publicPaths = [...new Set([...interfaces.values()].flat())]
  const listedDependencies = strings(raw.dependencies, `${where} dependencies`, problems) ?? []
  const interfaceDependencies = new Map<string, string[]>()
  for (const entry of listedDependencies) {
    const [pack, face] = entry.split("#")
    if (pack === undefined || face === undefined) continue
    interfaceDependencies.set(pack, [...(interfaceDependencies.get(pack) ?? []), face])
  }
  const bare = new Set(listedDependencies.filter((entry) => !entry.includes("#")))
  for (const pack of bare) interfaceDependencies.delete(pack)
  const metadata = raw.metadata
  return {
    name,
    layer: typeof layer === "string" ? layer : undefined,
    enforceDependencies: flag(raw.enforce_dependencies, `${where} enforce_dependencies`, problems, true),
    enforcePrivacy: flag(raw.enforce_privacy, `${where} enforce_privacy`, problems, true),
    enforceLayers: flag(raw.enforce_layers, `${where} enforce_layers`, problems, true),
    dependencies: [...new Set(listedDependencies.map((entry) => entry.split("#")[0] ?? entry))],
    interfaceDependencies,
    publicPaths,
    interfaces,
    enforcePublicTypes: flag(raw.enforce_public_types, `${where} enforce_public_types`, problems, false),
    ownsTables: strings(raw.owns_tables, `${where} owns_tables`, problems) ?? [],
    metadata: typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>) : {},
  }
}
