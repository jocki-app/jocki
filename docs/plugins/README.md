# File extension SDK

Jocki extensions use `jocki-extensions/1` manifests, shared vault files and core-managed drafts. The application does not load the former plugin/table packages or VS Code extensions.

Start with the [file extension guide](../file-extensions.md), [host design](../extension-host-design.md), [SDK contracts](../../packages/platform/src/file-sdk/index.ts), and [runnable example](../../examples/file-extension).

Declare editors, content/MIME selectors, commands, menus, keybindings, views, configuration, completion and search providers before code activation. Hooks cover document open/change/will-save/did-save/close, active editor, vault folders and configuration. Registrations are disposable; activation is lazy and revocable.

Content belongs in ordinary vault files and must remain within the extension's declared content contract. Search and completion providers read matching documents; editors and document observers can propose edits. Settings live in the workspace defaults/computer overrides. Multiple extensions can support the same registered type.

Propose shared content types, MIME types and minimal CSDB requirements through a pull request to [jocki-content-types](https://github.com/jocki-app/jocki/tree/main/registries/jocki-content-types). The app consumes a reviewed, pinned YAML/JSON snapshot.

External browser logic runs on worker threads inside opaque-origin hosts. Editor webviews have separate scoped ports and cannot directly save files. Signed ZIP verification and publisher trust happen before code loading. Native entrypoints require explicit local capability support; replicated settings do not authorize native execution.
