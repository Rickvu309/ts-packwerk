# Changelog

## 0.1.4

- `tests: true` checks test files and `testing/` folders that `exclude` would drop. A test is held to its pack's dependencies, may import that pack's private files, and may import a devDependency of its package or of the repository root. `test_exempt` leaves named tests unchecked.

## 0.1.3

- The `docs` page says it is written from every `pack.yml`, which is what it reads since 0.1.2.

## 0.1.2

- `import.meta.glob` with string-literal patterns adds one reference per included file it matches, relative to the importing file; `!` patterns exclude.
- `check` names each loop the real references make between packs of one package, after its summary, and whether known violations, new ones or unchecked uses close it. `explain` shows the loop a pack is in. Loops are reported, not failed.
- `explain` lists public files no other pack references.
- `docs` describes only what packs declare, so a new import never makes the page stale.
- A repository reached through a symlink resolves to its real path, so its imports are checked.

## 0.1.0

- First release: dependencies, privacy, named interfaces, layers, tables, public types, cycles and package rules, with `pack_todo.yml`, `explain`, `affected`, `docs` and an editor plugin.
