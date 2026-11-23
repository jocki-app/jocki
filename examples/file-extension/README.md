# File extension example

This extension declares a text editor, a command, and a setting. `activate` registers
providers when its editor or command is selected. Save hooks return draft edits;
the core owns the Save button and persistence. The browser host and editor both
use isolated frames and the standalone `vscode-jsonrpc` transport.

Package with `npm run extension:pack -- examples/file-extension /path/to/private.pem
/tmp/example.zip`. Keep signing keys outside the repository. In Settings →
Extensions → Install a signed ZIP, supply the public key and select the package.
Open a `.txt` file to activate the editor. TypeScript extensions can import SDK
types from `@jocki/platform/file-sdk`; bundle runtime imports into the entrypoint.
