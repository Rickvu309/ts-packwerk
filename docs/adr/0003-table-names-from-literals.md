# Find table names only inside string and template literals

`owns_tables` gives a SQL table to one pack. A regex for `schema.table` over source text also matches code: `session.body`, `deck.id`, `deck.js`. ts-packwerk reads string and template literals from the syntax tree and matches only the table names packs declare, so a property access never counts.

## Considered options

- A regex over the whole file: fast, and false positives on member access.
- Parsing SQL: exact, and a SQL parser for every dialect.
- Declared names inside literals: no false positives on code; a table name built at run time is not seen.

## Consequences

- Files that create every table, such as migrations, are listed in `table_exempt`.
- Database roles remain the run-time guard for table names built dynamically.
