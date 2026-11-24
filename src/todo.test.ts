import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "./cli.ts"
import { app, makeRepo, type Repo } from "./fixture.ts"

let repo: Repo
afterEach(() => repo.remove())

const run = async (...argv: string[]) => {
  const out: string[] = []
  const code = await runCli([...argv, "--root", repo.root], {
    out: (text) => out.push(text),
    err: (text) => out.push(text),
  })
  return { code, out: out.join("\n") }
}

const leaky =
  'import { button } from "../kit/index.js"\nimport type { Theme } from "../kit/theme.js"\nexport const Editor = button\nexport type Look = Theme\n'

describe("check and update-todo", () => {
  it("passes a clean repo", async () => {
    repo = makeRepo(app)
    repo.link("apps/web/node_modules/@acme/core", "packages/core")
    const result = await run("check")
    expect(result.out).toContain("0 new violations, 0 stale todos")
    expect(result.code).toBe(0)
  })

  it("records known violations, then fails only on new ones and on fixed ones still listed", async () => {
    repo = makeRepo({
      ...app,
      "apps/web/src/editor/pack.yml": "layer: feature\n",
      "apps/web/src/kit/pack.yml": "layer: platform\n",
      "apps/web/src/editor/editor.ts": leaky,
    })
    repo.link("apps/web/node_modules/@acme/core", "packages/core")

    const before = await run("check")
    expect(before.code).toBe(1)
    expect(before.out).toContain(
      "apps/web/src/editor/editor.ts:2:28  privacy  apps/web/src/kit/theme.ts is private to apps/web/src/kit",
    )

    const pruneOnly = await run("update-todo")
    expect(pruneOnly.code).toBe(1)
    expect(pruneOnly.out).toContain("these new violations are not recorded; fix them")

    expect((await run("update-todo", "--all")).code).toBe(0)
    const todo = readFileSync(path.join(repo.root, "apps/web/src/editor/pack_todo.yml"), "utf8")
    expect(todo).toContain(
      "apps/web/src/kit/theme.ts:\n    violations:\n      - dependency\n      - privacy\n    files:\n      - apps/web/src/editor/editor.ts",
    )
    expect((await run("check")).code).toBe(0)

    repo.write("apps/web/src/editor/lazy.ts", 'import { button } from "../kit/index.js"\nexport const lazy = button\n')
    const added = await run("check")
    expect(added.code).toBe(1)
    expect(added.out).toContain("apps/web/src/editor/lazy.ts:1:24  dependency")

    repo.write("apps/web/src/editor/lazy.ts", "export const lazy = 1\n")
    repo.write(
      "apps/web/src/editor/editor.ts",
      'import { button } from "../kit/index.js"\nexport const Editor = button\n',
    )
    const fixed = await run("check")
    expect(fixed.code).toBe(1)
    expect(fixed.out).toContain("stale  apps/web/src/editor/pack_todo.yml lists privacy on apps/web/src/kit/theme.ts")

    expect((await run("update-todo")).code).toBe(0)
    expect((await run("check")).out).toContain("0 new violations, 0 stale todos, 1 known")
  })

  it("names a loop of real references after the summary, and the loop in explain", async () => {
    repo = makeRepo({
      ...app,
      "apps/web/src/kit/index.ts":
        'import { Editor } from "../editor/index.js"\nexport const button = "button"\nexport const both = Editor\n',
    })
    repo.link("apps/web/node_modules/@acme/core", "packages/core")
    expect((await run("update-todo", "--all")).code).toBe(0)
    const checked = await run("check")
    expect(checked.code).toBe(0)
    expect(checked.out.split("\n").slice(-1)).toEqual([
      "loop through known violations: apps/web/src/editor, apps/web/src/kit (2 packs)",
    ])
    const explained = await run("explain", "apps/web/src/kit")
    expect(explained.out).toContain("loop: apps/web/src/editor, apps/web/src/kit (2 packs)")
    expect(explained.out).toContain("undeclared in the loop: apps/web/src/editor")
  })

  it("explains a pack for an agent about to change it", async () => {
    repo = makeRepo(app)
    repo.link("apps/web/node_modules/@acme/core", "packages/core")
    const result = await run("explain", "apps/web/src/kit")
    expect(result.code).toBe(0)
    expect(result.out).toContain("used by: apps/web/src/editor (2)")
    expect(result.out).toContain("public: apps/web/src/kit/index.ts")
  })
})

describe("the testing interface", () => {
  const kitWithFixtures = {
    ...app,
    "apps/web/src/kit/pack.yml": "layer: platform\npublic:\n  default: [index.ts, theme.ts]\n  testing: [testing/fixtures.ts]\n",
    "apps/web/src/kit/testing/fixtures.ts": "export const fixtures = 1\n",
    "apps/web/src/editor/pack.yml":
      "layer: feature\ndependencies: [apps/web/src/kit, apps/web/src/kit#testing]\n",
    "apps/web/src/editor/editor.test.ts":
      'import { fixtures } from "../kit/testing/fixtures.js"\nexport const test = fixtures\n',
  }

  it("passes a test that uses a declared testing interface", async () => {
    repo = makeRepo(kitWithFixtures)
    repo.link("apps/web/node_modules/@acme/core", "packages/core")
    const result = await run("check")
    expect(result.out).toContain("0 new violations, 0 stale todos")
    expect(result.code).toBe(0)
  })

  it("fails a product import of test support, and records it in pack_todo.yml", async () => {
    repo = makeRepo(kitWithFixtures)
    repo.link("apps/web/node_modules/@acme/core", "packages/core")
    repo.write(
      "apps/web/src/editor/plant.ts",
      'import { fixtures } from "../kit/testing/fixtures.js"\nexport const plant = fixtures\n',
    )
    const planted = await run("check")
    expect(planted.code).toBe(1)
    expect(planted.out).toContain(
      "apps/web/src/editor/plant.ts:1:26  testing  apps/web/src/kit/testing/fixtures.ts is test support in apps/web/src/kit; import it only from a test or a testing/ file",
    )
    expect(planted.out).not.toContain("plant.ts:1:26  testing  apps/web/src/editor uses")
    expect((await run("update-todo", "--all")).code).toBe(0)
    const todo = readFileSync(path.join(repo.root, "apps/web/src/editor/pack_todo.yml"), "utf8")
    expect(todo).toContain("violations:\n      - testing")
    expect((await run("check")).out).toContain("0 new violations, 0 stale todos, 1 known")
  })

  it("fails a test import the importer has not declared", async () => {
    repo = makeRepo({
      ...kitWithFixtures,
      "apps/web/src/editor/pack.yml": "layer: feature\ndependencies: [apps/web/src/kit]\n",
    })
    repo.link("apps/web/node_modules/@acme/core", "packages/core")
    const result = await run("check")
    expect(result.code).toBe(1)
    expect(result.out).toContain(
      "apps/web/src/editor/editor.test.ts:1:26  testing  apps/web/src/editor uses apps/web/src/kit's testing interface (apps/web/src/kit/testing/fixtures.ts) without declaring it; add apps/web/src/kit#testing to apps/web/src/editor/pack.yml dependencies",
    )
  })
})
