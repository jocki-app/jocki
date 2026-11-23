# CSDB package snapshot

`csvdatabase-csdb-0.0.0.tgz` packages the official sibling
`csvdatabase/csdb-typescript` working tree, including its schema/enum/array
changes and portable command entry point. Jocki imports
`@csvdatabase/csdb/portable`; no separate CSDB implementation lives in this app.

To refresh after reviewing and testing changes in that repository:

```sh
npm run check
npm pack --ignore-scripts --pack-destination /path/to/jocki/vendor
```

Then update the local dependency installation and the tarball's SHA-512
integrity in Jocki's `package-lock.json`. The package contains the library
license and README. Keep the source changes staged in `csdb-typescript` along
with the snapshot update here.
