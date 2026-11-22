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

  it("explains a pack for an agent about to change it", async () => {
    repo = makeRepo(app)
    repo.link("apps/web/node_modules/@acme/core", "packages/core")
    const result = await run("explain", "apps/web/src/kit")
    expect(result.code).toBe(0)
    expect(result.out).toContain("used by: apps/web/src/editor (2)")
    expect(result.out).toContain("public: apps/web/src/kit/index.ts")
  })
})
