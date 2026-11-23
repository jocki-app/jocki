import { readFileSync, writeFileSync } from "node:fs";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const compose = readFileSync("compose.yaml", "utf8")
  .replace(
    "ghcr.io/jocki/jocki:edge",
    `ghcr.io/jocki/jocki:${version}`,
  )
  .replace(
    /    build:\n      context: \.\n      dockerfile: deploy\/docker\/Dockerfile\n/,
    "",
  );
writeFileSync(process.argv[2], compose);
