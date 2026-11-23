# Changelog

## 0.1.2

- `import.meta.glob` with string-literal patterns adds one reference per included file it matches, relative to the importing file; `!` patterns exclude.
- `check` names each loop the real references make between packs of one package, after its summary, and whether known violations, new ones or unchecked uses close it. `explain` and `docs` show the loop a pack is in. Loops are reported, not failed.
- `explain` lists public files no other pack references, and `docs` counts them per pack.
- A repository reached through a symlink resolves to its real path, so its imports are checked.

## 0.1.0

- First release: dependencies, privacy, named interfaces, layers, tables, public types, cycles and package rules, with `pack_todo.yml`, `explain`, `affected`, `docs` and an editor plugin.
