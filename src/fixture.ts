import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

export type Repo = {
  readonly root: string
  write(file: string, text: string): void
  link(from: string, to: string): void
  remove(): void
}

export const makeRepo = (files: Readonly<Record<string, string>>): Repo => {
  const root = mkdtempSync(path.join(tmpdir(), "ts-packwerk-"))
  const write = (file: string, text: string): void => {
    const full = path.join(root, file)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
  for (const [file, text] of Object.entries(files)) write(file, text)
  const link = (from: string, to: string): void => {
    const full = path.join(root, from)
    mkdirSync(path.dirname(full), { recursive: true })
    symlinkSync(path.join(root, to), full, "dir")
  }
  return { root, write, link, remove: () => rmSync(root, { recursive: true, force: true }) }
}

export const app = {
  "packwerk.yml":
    'include:\n  - "apps/*/src/**/*.{ts,tsx}"\n  - "packages/*/src/**/*.ts"\nlayers: [app, feature, platform]\n',
  "package.json": JSON.stringify({ name: "root", private: true }),
  "apps/web/package.json": JSON.stringify({
    name: "web",
    dependencies: { "@acme/core": "workspace:*", react: "1" },
    devDependencies: { vitest: "1" },
  }),
  "apps/web/tsconfig.json": '{\n  // paths for the app\n  "compilerOptions": { "paths": { "@/*": ["./src/*"] } },\n}\n',
  "apps/web/src/pack.yml": "layer: app\ndependencies: [apps/web/src/editor, apps/web/src/kit]\n",
  "apps/web/src/main.ts":
    'import { Editor } from "@/editor/index.js"\nimport { core } from "@acme/core"\nexport const main = [Editor, core]\n',
  "apps/web/src/editor/pack.yml": "layer: feature\ndependencies: [apps/web/src/kit]\n",
  "apps/web/src/editor/index.ts": 'export { Editor } from "./editor.js"\n',
  "apps/web/src/editor/editor.ts":
    'import { button } from "../kit/index.js"\nimport type { Theme } from "../kit/theme.js"\nimport { readFileSync } from "node:fs"\nexport const Editor = { button, read: readFileSync }\nexport type Look = Theme\nexport const later = () => import("./lazy.js")\n',
  "apps/web/src/editor/lazy.ts": "export const lazy = 1\n",
  "apps/web/src/kit/pack.yml": "layer: platform\npublic: [index.ts, theme.ts]\n",
  "apps/web/src/kit/index.ts": 'export const button = "button"\n',
  "apps/web/src/kit/theme.ts": "export type Theme = { ink: string }\n",
  "packages/core/package.json": JSON.stringify({
    name: "@acme/core",
    type: "module",
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  }),
  "packages/core/tsconfig.json": JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "dist" } }),
  "packages/core/dist/index.js": "export const core = 1\n",
  "packages/core/src/index.ts": "export const core = 1\n",
}
