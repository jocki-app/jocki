# Jocki web bundle

Serve these files from a static web server over HTTPS (localhost is also supported). Do not open index.html using a file:// URL. Serve the contents of this archive as your web root.

For the Office plugin and WebAssembly threads, configure these response headers on every asset:

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp
    X-Content-Type-Options: nosniff

Serve .wasm as application/wasm. Keep HTML and the service worker revalidating so updates can be discovered. The Office runtime is bundled; its browser cache is populated and verified on first use. Automerge Repo persists browser documents in IndexedDB. Portable Automerge bundle import/export uses ordinary file uploads and downloads.

Peer networking uses approved devices and reachable peer/relay addresses. Hosting the web files does not itself run a peer. Use the release's server Compose file for an independent always-on peer, and follow https://github.com/jocki-app/jocki/blob/main/docs/self-hosting.md to pair it.

https://jocki.app
https://github.com/jocki-app/jocki
