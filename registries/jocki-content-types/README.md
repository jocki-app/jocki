# Jocki content types

The standalone registry and pull-request workflow live at
[jocki/jocki-content-types](https://github.com/jocki-app/jocki-content-types).
This directory is the app's pinned snapshot. Run `npm run registry:update` to
fetch the pinned commit, or `npm run registry:update -- <full-commit-sha>` for a
reviewed update. Commit the YAML, generated JSON and provenance together.

A content type describes file contents, not a plugin's private database. Multiple
plugins can support the same type. Untyped files remain valid files.

Edit `registry.yaml`, run `npm install && npm run generate && npm run check`, and
open a pull request including both YAML and generated JSON. Declare MIME types,
extensions and the smallest useful required fields. Keep additional fields open
for other plugins. Never include credentials or runtime commands. Incompatible
contracts need a new type ID. New MIME strings here are application conventions,
not a claim of IANA registration.

The application consumes this checked JSON snapshot. Registry changes are proposed
in the independent repository and incorporated by commit SHA.

This checkout carries a local CSDB format 2 adaptation recorded in `source.json`: table contracts use qualified names and the task contract retains required UID/DTSTAMP plus the independent row ID. New task files contain only these three columns; behavior fields such as title and native enum status are optional. Review these local changes when updating the upstream snapshot.
