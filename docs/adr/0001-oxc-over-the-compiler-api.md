# Read imports with oxc, not the TypeScript compiler API

ts-packwerk must answer in well under a second, so agents and pre-commit hooks can run it on every change. Building a TypeScript program to read imports loads every type and every `@types` package; on a 1,400-file monorepo that takes seconds. oxc-parser reads a file's import and export records in Rust, in parallel, without building types, and oxc-resolver resolves specifiers the way Node and TypeScript do (`tsconfig` paths, `package.json` exports, extension aliases).

## Considered options

- The TypeScript compiler API: exact types, seconds per run, and `typescript` as a runtime dependency.
- A regex over source text: fast, and wrong on comments, strings and multi-line imports.
- oxc-parser and oxc-resolver: native bindings per platform, 0.75 s on 1,400 files and 0.67 s on 5,000 small files.

## Consequences

- `import(variable)` cannot be checked; only string-literal dynamic imports count.
- A workspace package resolves to source through its `exports` map even before it is built.
- Native bindings must exist for each platform the tool runs on.
