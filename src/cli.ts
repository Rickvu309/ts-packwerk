import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { affected, docs, loopMembers, sarif, starterConfig, unusedPublic } from "./report.ts"
import { findings, referenceLoops, todoRules, type Finding, type Loop } from "./rules.ts"
import { judge, readTodos, writeTodos, type Verdict } from "./todo.ts"
import { configFile, loadWorkspace, packOf, type Pack, type Workspace } from "./workspace.ts"

type Io = { readonly out: (line: string) => void; readonly err: (line: string) => void }

const usage = `usage: ts-packwerk <command> [options]

commands:
  init                  write a starter ${configFile}
  check [--json|--sarif]  report references that break pack rules and are not in a pack_todo.yml
  update-todo           remove fixed violations from pack_todo.yml files
  update-todo --all     record every current violation, for a repo adopting packs
  explain <pack>        describe a pack: its rules, public paths, what it uses and what uses it
  affected [files...]   list the packs a change reaches; without files, the files changed since --base
  docs --out <file>     write a page of every pack, its layer, interfaces and dependencies
  docs --out <file> --check  fail when that page is stale

options:
  --root <dir>          repository root (default: nearest folder with ${configFile})
  --base <ref>          git ref for affected (default: origin/main)`

const line = (finding: Finding): string =>
  `${finding.file}:${String(finding.line)}:${String(finding.column)}  ${finding.rule}  ${finding.message}`

const counted = (items: readonly string[]): string[] => {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([item, count]) => `${item} (${String(count)})`)
}

const closedBy = (loop: Loop, verdict: Verdict): string => {
  const closing =
    ([from, to]: readonly [string, string]) =>
    (finding: Finding) =>
      finding.rule === "dependency" && finding.fromPack === from && finding.toPack === to
  if (loop.undeclared.some((edge) => verdict.fresh.some(closing(edge)))) return "new violations"
  return loop.undeclared.every((edge) => verdict.listed.some(closing(edge))) ? "known violations" : "unchecked uses"
}

const loopLines = (workspace: Workspace, pack: Pack): string[] => {
  const loop = referenceLoops(workspace).find((item) => item.packs.includes(pack.name))
  if (loop === undefined) return ["loop: none"]
  const undeclared = loop.undeclared.filter(([from]) => from === pack.name).map(([, to]) => to)
  return [`loop: ${loopMembers(loop)}`, `undeclared in the loop: ${undeclared.join(", ") || "none"}`]
}

const explain = (workspace: Workspace, name: string, io: Io): number => {
  const pack = workspace.packs.find((item) => item.name === name)
  if (pack === undefined) {
    io.err(`no pack named ${name}; packs: ${workspace.packs.map((item) => item.name).join(", ")}`)
    return 2
  }
  const owned = workspace.files.filter((file) => packOf(workspace.packs, file) === pack)
  const outgoing: string[] = []
  const incoming: string[] = []
  for (const reference of workspace.references) {
    if (reference.target.kind !== "file") continue
    const from = packOf(workspace.packs, reference.file)
    const to = packOf(workspace.packs, reference.target.file)
    if (from === undefined || to === undefined || from === to) continue
    if (from === pack) outgoing.push(to.name)
    if (to === pack) incoming.push(from.name)
  }
  const todos = readTodos(workspace.root, [pack]).get(pack.name) ?? []
  const rules = [
    pack.enforceDependencies && "dependencies",
    pack.enforcePrivacy && "privacy",
    pack.enforceLayers && pack.layer !== undefined && "layers",
    pack.enforcePublicTypes && "public types",
  ].filter((item) => item !== false)
  for (const text of [
    `# ${pack.name}`,
    "",
    `layer: ${pack.layer ?? "none"}`,
    `enforces: ${rules.join(", ") || "nothing"}`,
    `files: ${String(owned.length)}`,
    `public: ${[...pack.interfaces].map(([face, paths]) => (face === "default" ? paths.join(", ") : `${face}: ${paths.join(", ")}`)).join("; ") || "none"}`,
    `unused public: ${unusedPublic(workspace).get(pack.name)?.join(", ") || "none"}`,
    `owns tables: ${pack.ownsTables.join(", ") || "none"}`,
    `declared dependencies: ${pack.dependencies.join(", ") || "none"}`,
    `uses: ${counted(outgoing).join(", ") || "nothing"}`,
    `used by: ${counted(incoming).join(", ") || "nothing"}`,
    ...loopLines(workspace, pack),
    `open todos: ${String(todos.length)}`,
  ]) {
    io.out(text)
  }
  return 0
}

const findRoot = (start: string): string => {
  let directory = path.resolve(start)
  for (;;) {
    if (existsConfig(directory)) return directory
    const parent = path.dirname(directory)
    if (parent === directory) return path.resolve(start)
    directory = parent
  }
}

const existsConfig = (directory: string): boolean => existsSync(path.join(directory, configFile))

const valueOf = (args: string[], name: string): string | undefined => {
  const at = args.indexOf(name)
  return at >= 0 ? args.splice(at, 2)[1] : undefined
}

const changedSince = (root: string, base: string): string[] => {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })
  const fork = git("merge-base", "HEAD", base).trim()
  const listed = [git("diff", "--name-only", fork), git("ls-files", "--others", "--exclude-standard")]
  return [
    ...new Set(
      listed
        .join("\n")
        .split("\n")
        .filter((file) => file !== ""),
    ),
  ]
}

const commands = ["init", "check", "update-todo", "explain", "affected", "docs"]

export const runCli = async (argv: readonly string[], io: Io): Promise<number> => {
  const args = [...argv]
  const given = valueOf(args, "--root")
  const root = given === undefined ? findRoot(process.cwd()) : path.resolve(given)
  const out = valueOf(args, "--out")
  const base = valueOf(args, "--base") ?? "origin/main"
  const flags = new Set(args.filter((arg) => arg.startsWith("--")))
  const json = flags.has("--json")
  const all = flags.has("--all")
  const [command, ...rest] = args.filter((arg) => !arg.startsWith("--"))
  if (command === undefined || command === "help" || flags.has("--help")) {
    io.out(usage)
    return command === undefined ? 2 : 0
  }
  if (!commands.includes(command)) {
    io.err(`unknown command ${command}\n\n${usage}`)
    return 2
  }
  if (command === "init") {
    const file = path.join(root, configFile)
    if (existsSync(file)) {
      io.err(`${configFile} already exists`)
      return 1
    }
    writeFileSync(file, starterConfig)
    io.out(`wrote ${configFile}; add a pack.yml to each folder that should be a pack, then run ts-packwerk check`)
    return 0
  }
  const started = performance.now()
  const workspace = await loadWorkspace(root)
  if (workspace.problems.length > 0) {
    for (const problem of workspace.problems) io.err(`config  ${problem}`)
    return 2
  }
  if (command === "explain") return explain(workspace, rest[0] ?? "", io)
  if (command === "affected") {
    for (const pack of affected(workspace, rest.length > 0 ? rest : changedSince(root, base))) io.out(pack)
    return 0
  }
  if (command === "docs") {
    if (out === undefined) {
      io.err("docs needs --out <file>")
      return 2
    }
    const page = docs(workspace)
    const file = path.resolve(root, out)
    if (flags.has("--check")) {
      if (existsSync(file) && readFileSync(file, "utf8") === page) return 0
      io.err(`${out} is stale; run ts-packwerk docs --out ${out}`)
      return 1
    }
    writeFileSync(file, page)
    io.out(`wrote ${out}`)
    return 0
  }
  const found = findings(workspace)
  const verdict = judge(found, readTodos(root, workspace.packs))
  if (command === "update-todo") {
    const written = writeTodos(root, workspace.packs, all ? found : verdict.listed)
    io.out(`${String(written)} violations in pack_todo.yml files, ${String(verdict.stale.length)} fixed ones removed`)
    const unrecorded = all ? found.filter((item) => !todoRules.has(item.rule)) : verdict.fresh
    for (const finding of unrecorded) io.err(line(finding))
    if (!all && verdict.fresh.length > 0) io.err("these new violations are not recorded; fix them")
    return unrecorded.length === 0 ? 0 : 1
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(2)
  if (flags.has("--sarif")) {
    io.out(sarif(verdict.fresh))
  } else if (json) {
    io.out(JSON.stringify({ fresh: verdict.fresh, stale: verdict.stale, listed: verdict.listed.length }, null, 2))
  } else {
    for (const finding of verdict.fresh) io.out(line(finding))
    for (const entry of verdict.stale) {
      io.out(
        `${entry.file}  stale  ${entry.fromPack}/pack_todo.yml lists ${entry.rule} on ${entry.target}, which is fixed; run ts-packwerk update-todo`,
      )
    }
    io.out(
      `${String(workspace.files.length)} files, ${String(workspace.packs.length)} packs, ${String(verdict.fresh.length)} new violations, ${String(verdict.stale.length)} stale todos, ${String(verdict.listed.length)} known, ${seconds} s`,
    )
    for (const loop of referenceLoops(workspace))
      io.out(`loop through ${closedBy(loop, verdict)}: ${loopMembers(loop)}`)
  }
  return verdict.fresh.length === 0 && verdict.stale.length === 0 ? 0 : 1
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), {
    out: (text) => console.log(text),
    err: (text) => console.error(text),
  })
}
