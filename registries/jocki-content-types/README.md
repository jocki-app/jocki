# Jocki content types

The application owns these shared MIME and content-type contracts. Edit `registry.yaml` and run `npm run registry:update` from the repository root to validate and regenerate `registry.json`. Run `npm run registry:update -- --check` to verify generated output without changing it.

A content type describes file contents, not a plugin's private database. Multiple
plugins can support the same type. Untyped files remain valid files.

Edit `registry.yaml`, run `npm run registry:update` from the application root, and
open a pull request including both YAML and generated JSON. Declare MIME types,
extensions and the smallest useful required fields. Keep additional fields open
for other plugins. Never include credentials or runtime commands. Incompatible
contracts need a new type ID. New MIME strings here are application conventions,
not a claim of IANA registration.

The application consumes this checked JSON snapshot. Registry changes are proposed
in the independent repository and incorporated by commit SHA.

This checkout carries a local CSDB format 2 adaptation recorded in `source.json`: table contracts use qualified names and the task contract retains required UID/DTSTAMP plus the independent row ID. New task files contain only these three columns; behavior fields such as title and native enum status are optional. Review these local changes when updating the upstream snapshot.
