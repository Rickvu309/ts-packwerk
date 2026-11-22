import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "./cli.ts"
import { makeRepo, type Repo } from "./fixture.ts"

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

const json = (value: unknown) => JSON.stringify(value)

describe("a Next.js style app with an @/ alias", () => {
  it("keeps server code out of client components", async () => {
    repo = makeRepo({
      "package.json": json({ name: "shop", dependencies: { next: "15", react: "19" } }),
      "tsconfig.json": json({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
      "packwerk.yml": 'include: ["src/**/*.{ts,tsx}"]\nlayers: [app, ui, server]\n',
      "src/app/pack.yml": "layer: app\ndependencies: [src/components, src/server]\n",
      "src/app/page.tsx":
        'import { Cart } from "@/components/cart"\nimport { prices } from "@/server/prices"\nexport default function Page() { return Cart(prices()) }\n',
      "src/components/pack.yml": "layer: ui\npublic: [cart.tsx]\n",
      "src/components/cart.tsx":
        '"use client"\nimport { prices } from "@/server/prices"\nexport function Cart(list: number[]) { return [...list, ...prices()] }\n',
      "src/server/pack.yml": "layer: server\npublic: [prices.ts]\n",
      "src/server/prices.ts": "export function prices(): number[] { return [1] }\n",
    })
    const result = await run("check")
    expect(result.out).toContain("src/components/cart.tsx:2:24  dependency  src/components uses src/server")
    expect(result.out).not.toContain("src/app/page.tsx")
    expect(result.code).toBe(1)
  })
})

describe("a NestJS style modular backend", () => {
  it("reads decorated classes and stops one module reaching into another's service", async () => {
    repo = makeRepo({
      "package.json": json({ name: "api", dependencies: { "@nestjs/common": "11" } }),
      "packwerk.yml": 'include: ["src/**/*.ts"]\n',
      "src/users/pack.yml": "public: [users.module.ts]\n",
      "src/users/users.module.ts":
        'import { Module } from "@nestjs/common"\nimport { UsersService } from "./users.service.js"\n@Module({ providers: [UsersService], exports: [UsersService] })\nexport class UsersModule {}\n',
      "src/users/users.service.ts":
        'import { Injectable } from "@nestjs/common"\n@Injectable()\nexport class UsersService { find(id: string): string { return id } }\n',
      "src/orders/pack.yml": "dependencies: [src/users]\n",
      "src/orders/orders.service.ts":
        'import { Injectable } from "@nestjs/common"\nimport { UsersService } from "../users/users.service.js"\n@Injectable()\nexport class OrdersService { constructor(private readonly users: UsersService) {} }\n',
    })
    const result = await run("check")
    expect(result.out).toContain(
      "src/orders/orders.service.ts:2:30  privacy  src/users/users.service.ts is private to src/users",
    )
  })
})

describe("an Express monolith on one database", () => {
  it("fails SQL that names another module's table, and only in strings", async () => {
    repo = makeRepo({
      "package.json": json({ name: "store", dependencies: { express: "5", pg: "8" } }),
      "packwerk.yml": 'include: ["src/**/*.ts"]\ntable_exempt: ["src/migrations.ts"]\n',
      "src/users/pack.yml": "owns_tables: [public.users]\n",
      "src/users/index.ts":
        "export const readUser = (id: string): string => `select * from public.users where id = ${id}`\n",
      "src/billing/pack.yml": "owns_tables: [public.invoices]\ndependencies: [src/users]\n",
      "src/billing/index.ts":
        'const public_ = { users: 1 }\nexport const unpaid = "select * from public.invoices join public.users using (user_id)"\nexport const count: number = public_.users\n',
      "src/migrations.ts":
        'export const up = "create table public.users (id text); create table public.invoices (id text)"\n',
    })
    const result = await run("check")
    expect(result.out).toContain("src/billing/index.ts:2:59  table  public.users belongs to src/users")
    expect(result.out).toContain("1 new violations")
  })
})

describe("npm or yarn workspaces", () => {
  it("checks package.json declarations across workspaces and runtime use of dev packages", async () => {
    repo = makeRepo({
      "package.json": json({ name: "mono", private: true, workspaces: ["packages/*"] }),
      "packwerk.yml": 'include: ["packages/*/src/**/*.ts"]\n',
      "packages/core/package.json": json({ name: "@mono/core", exports: { ".": "./src/index.ts" } }),
      "packages/core/src/index.ts": "export const core = 1\n",
      "packages/web/package.json": json({ name: "@mono/web", devDependencies: { vitest: "3" } }),
      "packages/web/src/index.ts":
        'import { core } from "@mono/core"\nimport { expect } from "vitest"\nexport const web = [core, expect]\n',
    })
    repo.link("node_modules/@mono/core", "packages/core")
    const result = await run("check")
    expect(result.out).toContain(
      "packages/web/src/index.ts:1:22  package  @mono/core is not in the nearest package.json",
    )
    expect(result.out).toContain("packages/web/src/index.ts:2:24  package  vitest is a devDependency but runs here")
  })
})

describe("a legacy monolith adopting packs", () => {
  it("records today's violations once, then fails only new ones", async () => {
    repo = makeRepo({
      "package.json": json({ name: "legacy" }),
      "packwerk.yml": 'include: ["lib/**/*.ts"]\n',
      "lib/a/pack.yml": "\n",
      "lib/a/index.ts": 'import { b } from "../b/inner.js"\nexport const a = b\n',
      "lib/b/pack.yml": "\n",
      "lib/b/index.ts": "export const index = 1\n",
      "lib/b/inner.ts": "export const b = 1\n",
    })
    expect((await run("check")).code).toBe(1)
    expect((await run("update-todo", "--all")).code).toBe(0)
    expect((await run("check")).code).toBe(0)
    repo.write("lib/a/more.ts", 'import { index } from "../b/index.js"\nexport const more = index\n')
    const grown = await run("check")
    expect(grown.code).toBe(1)
    expect(grown.out).toContain("lib/a/more.ts:1:23  dependency")
    expect(grown.out).toContain("2 known")
  })
})
