import { readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "./cli.ts"
import { app, makeRepo, type Repo } from "./fixture.ts"
import { affected, affectedDistances, sarif } from "./report.ts"
import { exportTarget } from "./package-exports.ts"
import { typeGapsIn } from "./public-types.ts"
import { loadWorkspace } from "./workspace.ts"

let repo: Repo
afterEach(() => repo.remove())

const open = (extra: Record<string, string> = {}) => {
  repo = makeRepo({ ...app, ...extra })
  repo.link("apps/web/node_modules/@acme/core", "packages/core")
  return repo
}

const run = async (...argv: string[]) => {
  const out: string[] = []
  const code = await runCli([...argv, "--root", repo.root], {
    out: (text) => out.push(text),
    err: (text) => out.push(text),
  })
  return { code, out: out.join("\n") }
}

describe("named interfaces", () => {
  const faces = {
    "apps/web/src/kit/pack.yml": "layer: platform\npublic:\n  buttons: [index.ts]\n  themes: [theme.ts]\n",
    "apps/web/src/editor/pack.yml": "layer: feature\ndependencies: [apps/web/src/kit#buttons]\n",
  }

  it("lets a pack use only the interfaces it names", async () => {
    open(faces)
    const result = await run("check")
    expect(result.out).toContain(
      "apps/web/src/editor/editor.ts:2:28  interface  apps/web/src/editor may use only apps/web/src/kit#buttons, and apps/web/src/kit/theme.ts is outside it",
    )
    expect(result.out).not.toContain("editor.ts:1:24")
  })

  it("passes when the pack names every interface it uses", async () => {
    open({
      ...faces,
      "apps/web/src/editor/pack.yml":
        "layer: feature\ndependencies: [apps/web/src/kit#buttons, apps/web/src/kit#themes]\n",
    })
    expect((await run("check")).code).toBe(0)
  })

  it("refuses an interface the pack does not have", async () => {
    open({ ...faces, "apps/web/src/editor/pack.yml": "layer: feature\ndependencies: [apps/web/src/kit#colors]\n" })
    const result = await run("check")
    expect(result.code).toBe(2)
    expect(result.out).toContain("depends on apps/web/src/kit#colors, which is not one of its public interfaces")
  })
})

describe("public types", () => {
  it("names each export whose type a caller would have to infer", () => {
    const source = [
      "export function typed(a: number): number { return a }",
      "export function bare(a: number) { return a }",
      "export function loose(a): number { return a }",
      "export const answer = 42",
      "export const shape = { a: 1, b: [1, 2] } as const satisfies object",
      "export const spread = { ...base }",
      "export const kept: { a: number } = { a: 1 }",
      "export const arrow = (a: number): number => a",
      "export const guess = (a: number) => a",
      "export type Kept = { a: number }",
      "export default makeThing()",
    ].join("\n")
    expect(typeGapsIn("a.ts", source).map((gap) => `${String(gap.line)} ${gap.name}`)).toEqual([
      "2 bare",
      "3 loose parameters",
      "6 spread",
      "9 guess",
      "11 default",
    ])
  })

  it("checks the files a pack's public entry re-exports, and only those", async () => {
    open({
      "apps/web/src/kit/pack.yml": "layer: platform\npublic: [index.ts, theme.ts]\nenforce_public_types: true\n",
      "apps/web/src/kit/index.ts": 'export { button } from "./button.js"\n',
      "apps/web/src/kit/button.ts": "export const button = () => 1\n",
      "apps/web/src/kit/inner.ts": "export const inner = () => 2\n",
    })
    const workspace = await loadWorkspace(repo.root)
    expect(workspace.typeGaps).toEqual([{ file: "apps/web/src/kit/button.ts", line: 1, column: 14, name: "button" }])
  })
})

describe("affected", () => {
  it("lists the changed file's pack and every pack that reaches it", async () => {
    const workspace = await loadWorkspace(open().root)
    expect(affected(workspace, ["apps/web/src/kit/theme.ts"])).toEqual([
      "apps/web/src",
      "apps/web/src/editor",
      "apps/web/src/kit",
    ])
    expect(affected(workspace, ["packages/core/src/index.ts"])).toEqual(["apps/web/src", "packages/core"])
    expect([...affectedDistances(workspace, ["apps/web/src/kit/theme.ts"])]).toEqual([
      ["apps/web/src/kit", 0],
      ["apps/web/src/editor", 1],
      ["apps/web/src", 2],
    ])
  })
})

describe("workspace packages", () => {
  it("resolves a workspace package to its source before it is built", async () => {
    open()
    rmSync(path.join(repo.root, "packages/core/dist"), { recursive: true })
    const workspace = await loadWorkspace(repo.root)
    expect(workspace.references.find((item) => item.specifier === "@acme/core")?.target).toEqual({
      kind: "file",
      file: "packages/core/src/index.ts",
      declared: "runtime",
    })
  })

  it("reads an exports map the way Node does", () => {
    const manifest = {
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./x/*": "./dist/x/*.js" },
    }
    expect(exportTarget(manifest, ".")).toBe("./dist/index.js")
    expect(exportTarget(manifest, "./x/y")).toBe("./dist/x/y.js")
    expect(exportTarget(manifest, "./z")).toBeUndefined()
    expect(exportTarget({ main: "lib/main.js" }, ".")).toBe("lib/main.js")
  })
})

describe("docs", () => {
  it("writes a page, passes its check, and fails the check once a pack changes", async () => {
    open()
    expect((await run("docs", "--out", "packs.md")).code).toBe(0)
    const page = readFileSync(path.join(repo.root, "packs.md"), "utf8")
    expect(page).toContain("  p_apps_web_src_editor --> p_apps_web_src_kit")
    expect(page).toContain("| Pack | Layer | Public | Unused public | Dependencies | Tables | Loop |")
    expect(page).toContain("| `apps/web/src/kit` | platform | index.ts, theme.ts | 0 | none | none | none |")
    expect(page).not.toContain("## Loops")
    expect((await run("docs", "--out", "packs.md", "--check")).code).toBe(0)
    repo.write("apps/web/src/kit/pack.yml", "layer: feature\npublic: [index.ts, theme.ts]\n")
    const stale = await run("docs", "--out", "packs.md", "--check")
    expect([stale.code, stale.out]).toEqual([1, "packs.md is stale; run ts-packwerk docs --out packs.md"])
  })
})

describe("docs loops", () => {
  it("names the loop each pack is in and lists every loop", async () => {
    open({
      "apps/web/src/kit/index.ts":
        'import { Editor } from "../editor/index.js"\nexport const button = "button"\nexport const both = Editor\n',
    })
    expect((await run("docs", "--out", "packs.md")).code).toBe(0)
    const page = readFileSync(path.join(repo.root, "packs.md"), "utf8")
    expect(page).toContain("| `apps/web/src/kit` | platform | index.ts, theme.ts | 0 | none | none | 1 |")
    expect(page).toContain("| `apps/web/src` | app | none | 0 | apps/web/src/editor, apps/web/src/kit | none | none |")
    expect(page).toContain("## Loops\n\n1. apps/web/src/editor, apps/web/src/kit (2 packs)\n")
  })
})

describe("unused public paths", () => {
  it("lists public files no other pack references, in explain and as a count in docs", async () => {
    open({
      "apps/web/src/kit/pack.yml": "layer: platform\npublic: [index.ts, theme.ts, spare.ts]\n",
      "apps/web/src/kit/spare.ts": "export const spare = 1\n",
      "apps/web/src/kit/index.ts": 'import { spare } from "./spare.js"\nexport const button = spare\n',
    })
    const explained = await run("explain", "apps/web/src/kit")
    expect(explained.out).toContain("unused public: apps/web/src/kit/spare.ts")
    expect((await run("explain", "apps/web/src/editor")).out).toContain("unused public: none")
    expect((await run("docs", "--out", "packs.md")).code).toBe(0)
    expect(readFileSync(path.join(repo.root, "packs.md"), "utf8")).toContain(
      "| `apps/web/src/kit` | platform | index.ts, theme.ts, spare.ts | 1 | none | none | none |",
    )
  })
})

describe("sarif and init", () => {
  it("reports findings as SARIF 2.1.0 with a region per finding", () => {
    const report = JSON.parse(
      sarif([
        {
          rule: "layer",
          file: "a.ts",
          line: 3,
          column: 7,
          fromPack: "a",
          toPack: "b",
          target: "b/x.ts",
          message: "no",
        },
      ]),
    ) as {
      version: string
      runs: { results: { ruleId: string; locations: { physicalLocation: { region: unknown } }[] }[] }[]
    }
    expect(report.version).toBe("2.1.0")
    expect(report.runs[0]?.results[0]?.ruleId).toBe("layer")
    expect(report.runs[0]?.results[0]?.locations[0]?.physicalLocation.region).toEqual({ startLine: 3, startColumn: 7 })
  })

  it("writes a starter config once", async () => {
    repo = makeRepo({ "src/index.ts": "export const a = 1\n" })
    expect((await run("init")).code).toBe(0)
    expect((await run("init")).code).toBe(1)
    expect((await run("check")).out).toContain("1 files, 0 packs, 0 new violations")
  })
})

describe("lint", () => {
  it("reports a file's new violations where they are, and skips recorded ones", async () => {
    const { boundaries } = await import("./lint.ts")
    open({ "apps/web/src/kit/pack.yml": "layer: platform\n" })
    const reports: string[] = []
    const lint = (file: string) =>
      boundaries
        .create({
          filename: path.join(repo.root, file),
          report: ({ loc, message }) =>
            reports.push(`${String(loc.start.line)}:${String(loc.start.column)} ${message}`),
        })
        .Program?.()
    lint("apps/web/src/editor/editor.ts")
    expect(reports).toEqual([
      "2:27 privacy: apps/web/src/kit/theme.ts is private to apps/web/src/kit; import a public path (apps/web/src/kit/index.ts) or add this file to its public list",
    ])
    reports.length = 0
    expect((await run("update-todo", "--all")).code).toBe(0)
    lint("apps/web/src/editor/editor.ts")
    expect(reports).toEqual([])
  })
})
