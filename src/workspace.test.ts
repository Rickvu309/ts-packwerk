import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { app, makeRepo, type Repo } from "./fixture.ts"
import { tableUsesIn } from "./tables.ts"
import { loadWorkspace, packOf } from "./workspace.ts"

let repo: Repo
afterEach(() => repo.remove())

const open = async (extra: Record<string, string> = {}) => {
  repo = makeRepo({ ...app, ...extra })
  repo.link("apps/web/node_modules/@acme/core", "packages/core")
  return loadWorkspace(repo.root)
}

const reference = (workspace: Awaited<ReturnType<typeof open>>, file: string, specifier: string) =>
  workspace.references.find((item) => item.file === file && item.specifier === specifier)

describe("loadWorkspace", () => {
  it("lists the included files and the packs that own them", async () => {
    const workspace = await open()
    expect(workspace.problems).toEqual([])
    expect(workspace.files).toContain("apps/web/src/editor/editor.ts")
    expect(workspace.files).not.toContain("packages/core/dist/index.js")
    expect(workspace.packs.map((pack) => pack.name)).toEqual([
      "apps/web/src",
      "apps/web/src/editor",
      "apps/web/src/kit",
    ])
    expect(packOf(workspace.packs, "apps/web/src/editor/lazy.ts")?.name).toBe("apps/web/src/editor")
    expect(packOf(workspace.packs, "apps/web/src/main.ts")?.name).toBe("apps/web/src")
    expect(packOf(workspace.packs, "packages/core/src/index.ts")).toBeUndefined()
    expect(workspace.packageRoots).toEqual(["apps/web", "packages/core"])
  })

  it("defaults a pack's public path to its index file", async () => {
    const workspace = await open({ "apps/web/src/kit/pack.yml": "layer: platform\n" })
    expect(workspace.packs.find((pack) => pack.name === "apps/web/src/kit")?.publicPaths).toEqual([
      "apps/web/src/kit/index.ts",
    ])
  })

  it("resolves relative, aliased, workspace, external and builtin references", async () => {
    const workspace = await open()
    expect(reference(workspace, "apps/web/src/editor/editor.ts", "../kit/index.js")).toMatchObject({
      line: 1,
      column: 24,
      typeOnly: false,
      target: { kind: "file", file: "apps/web/src/kit/index.ts" },
    })
    expect(reference(workspace, "apps/web/src/editor/editor.ts", "../kit/theme.js")).toMatchObject({ typeOnly: true })
    expect(reference(workspace, "apps/web/src/main.ts", "@/editor/index.js")?.target).toEqual({
      kind: "file",
      file: "apps/web/src/editor/index.ts",
    })
    expect(reference(workspace, "apps/web/src/main.ts", "@acme/core")?.target).toEqual({
      kind: "file",
      file: "packages/core/src/index.ts",
      declared: "runtime",
    })
    expect(reference(workspace, "apps/web/src/editor/editor.ts", "node:fs")?.target).toEqual({ kind: "builtin" })
    expect(reference(workspace, "apps/web/src/editor/editor.ts", "./lazy.js")?.target).toEqual({
      kind: "file",
      file: "apps/web/src/editor/lazy.ts",
    })
  })

  it("says whether an external package is declared, and how", async () => {
    const workspace = await open({
      "apps/web/src/kit/index.ts":
        'import "react"\nimport { it } from "vitest"\nimport left from "left-pad"\nexport const button = [it, left]\n',
    })
    const kit = "apps/web/src/kit/index.ts"
    expect(reference(workspace, kit, "react")?.target).toEqual({ kind: "package", name: "react", declared: "runtime" })
    expect(reference(workspace, kit, "vitest")?.target).toEqual({ kind: "package", name: "vitest", declared: "dev" })
    expect(reference(workspace, kit, "left-pad")?.target).toEqual({
      kind: "package",
      name: "left-pad",
      declared: "missing",
    })
  })

  it("reports manifest problems instead of guessing", async () => {
    const workspace = await open({
      "apps/web/src/kit/pack.yml": "layer: nowhere\ndependencies: [apps/web/src/ghost]\npublic: [missing.ts]\n",
    })
    expect(workspace.problems).toEqual([
      "apps/web/src/kit/pack.yml layer nowhere is not one of packwerk.yml layers",
      "apps/web/src/kit/pack.yml public path apps/web/src/kit/missing.ts does not exist",
      "apps/web/src/kit/pack.yml depends on apps/web/src/ghost, which is not a pack",
    ])
  })
})

describe("tableUsesIn", () => {
  it("finds a table only inside string and template literals, never in member access", () => {
    const source = [
      "const deck = { doom: 1, id: 2 }",
      "const doom = deck.doom + deck.id",
      'const read = "select * from deck.doom where id = $1"',
      "const write = `insert into deck.doom_edit (deck) values (${doom})`",
      'const near = "deck.doomed is another name"',
    ].join("\n")
    expect(tableUsesIn("a.ts", source, ["deck.doom", "deck.doom_edit", "deck.id"])).toEqual([
      { file: "a.ts", line: 3, column: 29, table: "deck.doom" },
      { file: "a.ts", line: 4, column: 28, table: "deck.doom_edit" },
    ])
  })
})

describe("owns_tables", () => {
  it("collects each pack's tables and their uses in other packs", async () => {
    const workspace = await open({
      "apps/web/src/kit/pack.yml": "layer: platform\npublic: [index.ts, theme.ts]\nowns_tables: [app.theme]\n",
      "apps/web/src/editor/lazy.ts": 'export const lazy = "select ink from app.theme"\n',
    })
    expect(workspace.tableUses).toEqual([
      { file: "apps/web/src/editor/lazy.ts", line: 1, column: 38, table: "app.theme" },
    ])
  })

  it("refuses a table owned by two packs", async () => {
    const workspace = await open({
      "apps/web/src/kit/pack.yml": "layer: platform\npublic: [index.ts, theme.ts]\nowns_tables: [app.theme]\n",
      "apps/web/src/editor/pack.yml": "layer: feature\ndependencies: [apps/web/src/kit]\nowns_tables: [app.theme]\n",
    })
    expect(workspace.problems).toEqual(["app.theme is owned by both apps/web/src/editor and apps/web/src/kit"])
  })
})

describe("a repository reached through a symlink", () => {
  it("resolves imports to files inside it, as macOS temp folders need", async () => {
    repo = makeRepo({ ...app })
    repo.link("apps/web/node_modules/@acme/core", "packages/core")
    const linked = path.join(mkdtempSync(path.join(tmpdir(), "ts-packwerk-link-")), "repo")
    symlinkSync(repo.root, linked, "dir")
    const workspace = await loadWorkspace(linked)
    expect(reference(workspace, "apps/web/src/editor/editor.ts", "../kit/index.js")?.target).toEqual({
      kind: "file",
      file: "apps/web/src/kit/index.ts",
    })
    rmSync(path.dirname(linked), { recursive: true, force: true })
  })
})
