import { describe, expect, it } from "vitest"
import { dependencyCycles, findings, referenceLoops } from "./rules.ts"
import type { Pack, Reference, Workspace } from "./workspace.ts"

const pack = (name: string, extra: Partial<Pack> = {}): Pack => ({
  name,
  layer: undefined,
  enforceDependencies: true,
  enforcePrivacy: true,
  enforceLayers: true,
  dependencies: [],
  publicPaths: [`${name}/index.ts`],
  interfaces: new Map([["default", [`${name}/index.ts`]]]),
  interfaceDependencies: new Map(),
  declaredInterfaces: new Map(),
  enforcePublicTypes: false,
  ownsTables: [],
  metadata: {},
  ...extra,
})

const uses = (file: string, target: string, specifier = "./x.js"): Reference => ({
  file,
  line: 1,
  column: 1,
  specifier,
  typeOnly: false,
  reexport: false,
  target: { kind: "file", file: target },
})

const workspace = (packs: Pack[], references: Reference[], packageRoots = ["app"]): Workspace => ({
  root: "/repo",
  config: {
    include: [],
    exclude: [],
    layers: ["app", "legacy", "feature", "platform"],
    tableExempt: [],
    tests: false,
    testExempt: [],
  },
  packs,
  files: [],
  references,
  packageRoots,
  tableUses: [],
  typeGaps: [],
  problems: [],
})

const rules = (space: Workspace) => findings(space).map((item) => `${item.rule} ${item.file} -> ${item.target}`)

describe("findings", () => {
  it("passes a reference to a declared pack's public path", () => {
    const space = workspace(
      [pack("app/editor", { dependencies: ["app/kit"] }), pack("app/kit")],
      [uses("app/editor/a.ts", "app/kit/index.ts")],
    )
    expect(rules(space)).toEqual([])
  })

  it("flags an undeclared pack and a private file", () => {
    const space = workspace([pack("app/editor"), pack("app/kit")], [uses("app/editor/a.ts", "app/kit/inner.ts")])
    expect(rules(space)).toEqual([
      "dependency app/editor/a.ts -> app/kit/inner.ts",
      "privacy app/editor/a.ts -> app/kit/inner.ts",
    ])
  })

  it("lets a pack opt out of each rule", () => {
    const space = workspace(
      [pack("app/editor", { enforceDependencies: false }), pack("app/kit", { enforcePrivacy: false })],
      [uses("app/editor/a.ts", "app/kit/inner.ts")],
    )
    expect(rules(space)).toEqual([])
  })

  it("keeps a lower layer from using a higher one, so a legacy pack stays quarantined", () => {
    const space = workspace(
      [
        pack("app/doom", { layer: "feature", dependencies: ["app/old"] }),
        pack("app/old", { layer: "legacy", dependencies: ["app/doom"] }),
      ],
      [uses("app/doom/a.ts", "app/old/index.ts"), uses("app/old/b.ts", "app/doom/index.ts")],
    )
    expect(rules(space)).toEqual([
      "layer app/doom/a.ts -> app/old/index.ts",
      "cycle app/doom/pack.yml -> app/doom -> app/old",
    ])
  })

  it("leaves references between packages to package.json", () => {
    const space = workspace(
      [pack("app/editor"), pack("lib/core", { publicPaths: ["lib/core/src/index.ts"] })],
      [uses("app/editor/a.ts", "lib/core/src/index.ts", "@acme/core")],
      ["app", "lib/core"],
    )
    expect(rules(space)).toEqual([])
  })

  it("flags a relative path that leaves its package", () => {
    const space = workspace([], [uses("app/a.ts", "lib/core/src/x.ts", "../lib/core/src/x.js")], ["app", "lib/core"])
    expect(rules(space)).toEqual(["package app/a.ts -> lib/core/src/x.ts"])
  })

  it("flags packages missing from package.json and dev packages that run", () => {
    const reference = (name: string, declared: "runtime" | "dev" | "missing", typeOnly = false): Reference => ({
      ...uses("app/a.ts", ""),
      specifier: name,
      typeOnly,
      target: { kind: "package", name, declared },
    })
    const space = workspace(
      [],
      [
        reference("react", "runtime"),
        reference("vitest", "dev"),
        reference("vite", "dev", true),
        reference("left-pad", "missing"),
      ],
    )
    expect(rules(space)).toEqual(["package app/a.ts -> vitest", "package app/a.ts -> left-pad"])
  })

  it("lets a test use a devDependency, and still flags one in product code", () => {
    const reference = (file: string, name: string): Reference => ({
      ...uses(file, ""),
      specifier: name,
      target: { kind: "package", name, declared: "dev" },
    })
    const space = workspace(
      [],
      [
        reference("app/a.test.ts", "vitest"),
        reference("app/testing/harness.ts", "fast-check"),
        reference("app/a.ts", "vitest"),
      ],
    )
    expect(rules({ ...space, config: { ...space.config, tests: true } })).toEqual(["package app/a.ts -> vitest"])
  })

  it("lets a test use its own pack's private files and flags another pack's", () => {
    const space = workspace(
      [pack("app/editor", { dependencies: ["app/kit"] }), pack("app/kit")],
      [
        uses("app/editor/editor.test.ts", "app/editor/editor.ts"),
        uses("app/editor/editor.test.ts", "app/kit/hidden.ts"),
      ],
    )
    expect(rules({ ...space, config: { ...space.config, tests: true } })).toEqual([
      "privacy app/editor/editor.test.ts -> app/kit/hidden.ts",
    ])
  })
})

describe("the testing interface", () => {
  const support = (name = "app/kit"): Pack =>
    pack(name, {
      publicPaths: [`${name}/index.ts`, `${name}/testing/fixtures.ts`],
      interfaces: new Map([
        ["default", [`${name}/index.ts`]],
        ["testing", [`${name}/testing/fixtures.ts`]],
      ]),
    })

  const importer = (name = "app/editor", extra: Partial<Pack> = {}): Pack =>
    pack(name, { dependencies: ["app/kit"], ...extra })

  const messages = (space: Workspace) => findings(space).map((item) => `${item.rule}: ${item.message}`)

  it("lets a test of a pack that declares the interface use it", () => {
    const space = workspace(
      [importer("app/editor", { declaredInterfaces: new Map([["app/kit", ["testing"]]]) }), support()],
      [uses("app/editor/editor.test.ts", "app/kit/testing/fixtures.ts")],
    )
    expect(messages(space)).toEqual([])
  })

  it("lets a testing/ file of a pack that declares the interface use it", () => {
    const space = workspace(
      [importer("app/editor", { declaredInterfaces: new Map([["app/kit", ["testing"]]]) }), support()],
      [uses("app/editor/testing/setup.ts", "app/kit/testing/fixtures.ts")],
    )
    expect(messages(space)).toEqual([])
  })

  it("flags a product file for importing test support it has not declared", () => {
    const space = workspace([importer(), support()], [uses("app/editor/editor.ts", "app/kit/testing/fixtures.ts")])
    expect(messages(space)).toEqual([
      "testing: app/kit/testing/fixtures.ts is test support in app/kit; import it only from a test or a testing/ file",
      "testing: app/editor uses app/kit's testing interface (app/kit/testing/fixtures.ts) without declaring it; add app/kit#testing to app/editor/pack.yml dependencies",
    ])
  })

  it("flags a test that imports an undeclared interface", () => {
    const space = workspace([importer(), support()], [uses("app/editor/editor.test.ts", "app/kit/testing/fixtures.ts")])
    expect(messages(space)).toEqual([
      "testing: app/editor uses app/kit's testing interface (app/kit/testing/fixtures.ts) without declaring it; add app/kit#testing to app/editor/pack.yml dependencies",
    ])
  })

  it("flags the owning pack's product code importing its own test support, without asking for a declaration", () => {
    const space = workspace([support()], [uses("app/kit/product.ts", "app/kit/testing/fixtures.ts")])
    expect(messages(space)).toEqual([
      "testing: app/kit/testing/fixtures.ts is test support in app/kit; import it only from a test or a testing/ file",
    ])
  })

  it("keeps a bare dependency from erasing a declared testing interface", () => {
    const declared = { declaredInterfaces: new Map([["app/kit", ["testing"]]]) }
    const space = workspace([importer("app/editor", declared), support()], [
      uses("app/editor/editor.ts", "app/kit/testing/fixtures.ts"),
      uses("app/editor/editor.test.ts", "app/kit/testing/fixtures.ts"),
    ])
    expect(messages(space)).toEqual([
      "testing: app/kit/testing/fixtures.ts is test support in app/kit; import it only from a test or a testing/ file",
    ])
  })

  it("holds a declared interface, not a folder name", () => {
    const space = workspace(
      [
        pack("app/editor", { dependencies: ["app/kit"] }),
        pack("app/kit", {
          publicPaths: ["app/kit/index.ts", "app/kit/testing/fixtures.ts"],
          interfaces: new Map([["default", ["app/kit/index.ts", "app/kit/testing/fixtures.ts"]]]),
        }),
      ],
      [uses("app/editor/editor.ts", "app/kit/testing/fixtures.ts")],
    )
    expect(messages(space)).toEqual([])
  })

  it("lets a pack opt out of enforcing its declared dependencies", () => {
    const space = workspace(
      [pack("app/editor", { dependencies: ["app/kit"], enforceDependencies: false }), support()],
      [
        uses("app/editor/editor.test.ts", "app/kit/testing/fixtures.ts"),
        uses("app/editor/editor.ts", "app/kit/testing/fixtures.ts"),
      ],
    )
    expect(messages(space)).toEqual([
      "testing: app/kit/testing/fixtures.ts is test support in app/kit; import it only from a test or a testing/ file",
    ])
  })
})

describe("tables", () => {
  it("flags SQL naming another pack's table, and not the owner's own", () => {
    const space = {
      ...workspace([pack("app/doom", { ownsTables: ["deck.doom"] }), pack("app/mcp")], []),
      tableUses: [
        { file: "app/doom/store.ts", line: 3, column: 9, table: "deck.doom" },
        { file: "app/mcp/mcp.ts", line: 7, column: 22, table: "deck.doom" },
      ],
    }
    expect(
      findings(space).map(
        (item) => `${item.rule} ${item.file}:${String(item.line)} -> ${item.target} (${item.toPack})`,
      ),
    ).toEqual(["table app/mcp/mcp.ts:7 -> deck.doom (app/doom)"])
  })
})

describe("dependencyCycles", () => {
  it("finds each strongly connected set once, and self loops", () => {
    const cycles = dependencyCycles([
      pack("a", { dependencies: ["b"] }),
      pack("b", { dependencies: ["c"] }),
      pack("c", { dependencies: ["a", "d"] }),
      pack("d"),
      pack("e", { dependencies: ["e"] }),
    ])
    expect(cycles).toEqual([["a", "b", "c"], ["e"]])
  })
})

describe("referenceLoops", () => {
  it("finds packs whose real references form a loop, with the uses no pack.yml declares", () => {
    const space = workspace(
      [
        pack("app/a", { dependencies: ["app/b"] }),
        pack("app/b", { dependencies: ["app/c"] }),
        pack("app/c"),
        pack("app/d", { dependencies: ["app/e"] }),
        pack("app/e", { dependencies: ["app/d"] }),
        pack("lib/f"),
      ],
      [
        uses("app/a/x.ts", "app/b/index.ts"),
        uses("app/b/x.ts", "app/c/index.ts"),
        uses("app/c/x.ts", "app/a/index.ts"),
        uses("app/d/x.ts", "app/e/index.ts"),
        uses("app/e/x.ts", "app/d/index.ts"),
        uses("app/c/x.ts", "lib/f/index.ts", "@acme/f"),
        uses("lib/f/x.ts", "app/c/index.ts", "@acme/c"),
      ],
      ["app", "lib/f"],
    )
    expect(referenceLoops(space)).toEqual([{ packs: ["app/a", "app/b", "app/c"], undeclared: [["app/c", "app/a"]] }])
  })
})
