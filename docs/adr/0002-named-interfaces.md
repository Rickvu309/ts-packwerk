# A pack may expose named interfaces

One public entry per pack forces every caller to depend on everything it exports. A pack can instead split its public files into named interfaces (`public: { runtime: [...], evals: [...] }`), and a dependency can name one (`packages/mcp#runtime`). A pack that names interfaces of another may import only files in them, and the check fails otherwise (`interface`).

## Considered options

- One public entry per pack, as Packwerk's `app/public` folder: simple, but test-only or internal-tool exports reach every caller.
- One package per interface: real isolation, and a package, build and version for each split.
- Named interfaces inside one pack, after Spring Modulith: one line of config per interface, checked statically.

## Consequences

- A list under `public` is the interface `default`.
- A dependency on the pack itself, with no `#`, allows every interface.
