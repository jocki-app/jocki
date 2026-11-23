import {
  shareLink,
  parseShareLink,
} from "../../packages/core/vaults/share-invitation";
import { parseArgs } from "node:util";
import path from "node:path";
import os from "node:os";
import { readFile, writeFile, stat, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { NodeFileRuntime } from "../../packages/platform-node/file-runtime";
import { relayConnection } from "../../packages/core/relay-settings";
import type { ShareKind } from "../../packages/core/vaults/protected-sync";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    name: { type: "string" },
    vault: { type: "string", multiple: true },
    "sync-config": { type: "string" },
    "contact-card": { type: "boolean" },
    share: { type: "string" },
    "vault-id": { type: "string" },
    path: { type: "string" },
    grant: { type: "string" },
    access: { type: "string" },
    invitation: { type: "string" },
    join: { type: "string" },
    destination: { type: "string" },
    output: { type: "string" },
    "export-workspace": { type: "string" },
    "import-workspace": { type: "string" },
    once: { type: "boolean" },
    host: { type: "string" },
    port: { type: "string" },
    "no-ui": { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(`Jocki file workspace
  --data <app-data-directory> --name <workspace-name>
  --vault <folder>              Mount a vault; repeat for multiple folders
  --sync-config <json>          Local relay connection settings; offline by default
  --contact-card               Print this replica's public contact card
  --share workspace|vault|folder|file --vault-id <id> --path <relative-path>
  --grant <contact-card.json> --access read|edit --invitation <sync-link.txt>
  --join <sync-link.txt> --destination <empty-vault-folder>
  --output <sync-link.txt>    Store an invitation outside source control
  --export-workspace <file>     Export the workspace Automerge settings document
  --import-workspace <file>     Adopt settings, preserving local folder mounts
  --once                       Scan and persist, then exit
  --host 127.0.0.1 --port 8080 --no-ui
Web clients use their own local replicas and join explicitly granted shares.`);
  process.exit(0);
}
const syncFile = values["sync-config"] ?? process.env.JOCKI_SYNC_CONFIG;
if (values.access && !["read", "edit"].includes(values.access))
  throw Error("Use read or edit for --access");
const runtime = await NodeFileRuntime.open({
  directory: path.resolve(
    values.data ??
      process.env.JOCKI_DATA ??
      path.join(os.homedir(), ".jocki", "file-workspace"),
  ),
  name: values.name ?? process.env.JOCKI_NAME,
  vaults: values.vault ?? JSON.parse(process.env.JOCKI_VAULTS ?? "[]"),
  sync: syncFile
    ? relayConnection(JSON.parse(await readFile(syncFile, "utf8")))
    : undefined,
  intervalMs: Number(process.env.JOCKI_SYNC_INTERVAL_MS ?? 30000),
});
const command =
  values["contact-card"] ||
  values.share ||
  values.grant ||
  values.join ||
  values["export-workspace"] ||
  values["import-workspace"] ||
  values.once;
if (command) {
  try {
    let output: string | undefined;
    if (values["contact-card"]) output = runtime.repository.contactCard;
    if (values["import-workspace"]) {
      await runtime.workspace.adopt(
        new Uint8Array(await readFile(values["import-workspace"])),
        runtime.computer,
        runtime.workspace.settings(runtime.computer).vaults,
      );
      await runtime.library.rememberCurrent();
    }
    if (values["export-workspace"])
      await writeFile(values["export-workspace"], runtime.workspace.export(), {
        flag: "wx",
        mode: 0o600,
      });
    if (values.share) {
      if (!["workspace", "vault", "file", "folder"].includes(values.share))
        throw Error("Invalid share scope");
      const id = values["vault-id"] ?? [...runtime.vaults.keys()][0];
      const invitation = await runtime.share(
        id,
        values.share as ShareKind,
        values.path ?? "",
      );
      if (values.grant)
        await runtime.sync.grant(
          invitation,
          await readFile(values.grant, "utf8"),
          values.access === "read" ? "read" : "edit",
        );
      output = shareLink(invitation);
    } else if (values.grant) {
      if (!values.invitation)
        throw Error("--grant needs --invitation or --share");
      await runtime.sync.grant(
        parseShareLink(await readFile(values.invitation, "utf8")),
        await readFile(values.grant, "utf8"),
        values.access === "read" ? "read" : "edit",
      );
    }
    if (values.join) {
      const invitation = await readFile(values.join, "utf8"),
        scope = await runtime.sync.inspectInvitation(invitation);
      if (scope.doc().kind === "workspace") {
        const share = await runtime.sync.joinWorkspace(
          invitation,
          runtime.computer,
          runtime.workspace.settings(runtime.computer).vaults,
        );
        await runtime.library.rememberCurrent();
        output = JSON.stringify(
          { workspace: runtime.workspace.current.id, vaults: share.vaults },
          null,
          2,
        );
      } else {
        if (!values.destination)
          throw Error("--join needs --destination for a file, folder or vault");
        const destination = await runtime.add(values.destination);
        await runtime.join(invitation, destination, values.path ?? "");
        output = JSON.stringify({
          vault: destination.id,
          files: destination.list().length,
        });
      }
    }
    await runtime.scan();
    if (output) {
      if (values.output)
        await writeFile(values.output, output + "\n", {
          flag: "wx",
          mode: 0o600,
        });
      else console.log(output);
    }
  } finally {
    await runtime.close();
  }
  process.exit(0);
}
const host = values.host ?? process.env.JOCKI_HOST ?? "127.0.0.1",
  port = Number(values.port ?? process.env.PORT ?? 8080);
const serveUI = !values["no-ui"] && process.env.JOCKI_SERVE_UI !== "0",
  root = await realpath(process.env.JOCKI_UI_PATH ?? "dist").catch(() =>
    path.resolve("dist"),
  );
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const http = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          status: "ready",
          format: "saddle-workspace/1",
          ui: serveUI,
          vaults: runtime.vaults.size,
        }),
      );
      return;
    }
    if (!serveUI || !["GET", "HEAD"].includes(req.method ?? "")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const requested = path.resolve(
      root,
      "." + decodeURIComponent(url.pathname),
    );
    if (requested !== root && !requested.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const candidate =
      url.pathname === "/office-engine/cool.html"
        ? path.join(root, "office-editor.html")
        : requested;
    let file = await realpath(candidate).catch(() =>
      path.extname(candidate) ? candidate : path.join(root, "index.html"),
    );
    if (file === root || (await stat(file)).isDirectory())
      file = path.join(root, "index.html");
    file = await realpath(file);
    if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader(
      "Content-Type",
      types[path.extname(file)] ?? "application/octet-stream",
    );
    res.setHeader("Content-Length", (await stat(file)).size);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
http.listen(port, host, () =>
  console.log(
    JSON.stringify({
      ui: serveUI ? "http://" + host + ":" + port : null,
      workspace: runtime.workspace.current.id,
      vaults: [...runtime.vaults.values()].map((v) => ({
        id: v.id,
        name: v.name,
      })),
      health: "http://" + host + ":" + port + "/api/health",
    }),
  ),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  http.close();
  await runtime.close();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
