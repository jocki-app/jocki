export function activate(context) {
  context.commands.registerCommand("example.text-editor.tools", () => {});
  const files = () =>
    [
      ...new Map(
        context.workspace.documents.map((doc) => [
          doc.vault + "/" + doc.id,
          doc,
        ]),
      ).values(),
    ].map((doc) => ({
      id: doc.vault + "/" + doc.id,
      label: doc.path,
      command: "example.text-editor.uppercase",
    }));
  context.window.registerTreeDataProvider("example.text-editor.files", files);
  context.window.registerTreeDataProvider(
    "example.text-editor.navigator",
    files,
  );
  context.languages.registerCompletionProvider(
    "example.text-editor.words",
    () => [
      {
        label: "Jocki",
        insertText: "Jocki",
        detail: "Example extension completion",
      },
    ],
  );
  context.search.registerTextExtractor(
    "example.text-editor.search",
    (doc) => "extension-extracted " + doc.text,
  );
  context.commands.registerCommand(
    "example.text-editor.uppercase",
    async () => {
      const doc = context.window.activeDocument;
      if (doc)
        await context.workspace.updateDocument(doc.vault, doc.id, [
          { from: 0, to: doc.text.length, insert: doc.text.toUpperCase() },
        ]);
    },
  );
  context.workspace.onWillSaveDocument(({ document }) => {
    if (!context.configuration.get("example.text-editor.trim")) return;
    const text = document.text.replace(/[\t ]+$/gm, "");
    return text === document.text
      ? []
      : [{ from: 0, to: document.text.length, insert: text }];
  });
  context.editors.registerCustomEditorProvider("example.text-editor.preview", {
    resolve() {
      return {
        kind: "webview",
        html: `<pre id="preview" aria-label="Text preview"></pre><script>addEventListener("jocki-ready",()=>{const api=window.jockiEditor,node=document.getElementById("preview");node.textContent=api.document.text;api.onDidChangeDocument(doc=>{node.textContent=doc.text;});});</script>`,
      };
    },
  });
  context.editors.registerCustomEditorProvider("example.text-editor.editor", {
    resolve() {
      return {
        kind: "webview",
        html: `
        <style>body{font:15px system-ui;padding:16px}textarea{width:100%;height:70vh;font:inherit}p{color:#667}</style>
        <label>Text file<textarea id="text" aria-label="Extension text"></textarea></label><p id="state">Connecting…</p>
        <script>
          addEventListener("jocki-ready", () => {
            const api = window.jockiEditor, input = document.getElementById("text"), state = document.getElementById("state");
            input.value = api.document.text; state.textContent = "Changes remain in the tab until Save.";
            let pending = Promise.resolve();
            input.addEventListener("input", () => {
              const text = input.value;
              pending = pending.then(() => api.update([{from:0,to:api.document.text.length,insert:text}])).catch(error => {state.textContent=String(error)});
            });
            api.onDidChangeDocument(doc => {if(document.activeElement!==input)input.value=doc.text});
          });
        </script>`,
      };
    },
  });
}
