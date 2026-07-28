# Database migrations

Migration filenames are UTC timestamps followed by a short description:

```text
YYYYMMDDThhmm_description.sql
```

Create a new timestamp with `date -u +%Y%m%dT%H%M`. The build script discovers every
`.sql` file in this folder and embeds them in lexicographic order, so adding a migration
does not require editing a shared Rust list. Once a migration has shipped, its filename
and SQL are history: add another migration instead of renaming or rewriting it.

The existing migrations use the author time of the commit that introduced each one,
converted to UTC. Where one commit introduced two migrations in the same minute, their
descriptions preserve the order in which the numbered files originally ran.

Applied migrations are recorded by filename in the database's `chronie_migrations`
table. `PRAGMA user_version` remains a count so older app builds can still refuse a
database with a schema newer than they understand. The first timestamp-aware build
converts an existing `user_version` into the corresponding filename records before it
runs anything new.
