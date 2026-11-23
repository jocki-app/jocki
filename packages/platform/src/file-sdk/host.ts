import {
  CancellationToken,
  CancellationTokenSource,
  Disposable,
  Emitter,
} from "vscode-jsonrpc";
import {
  fileExtensionManifestSchema,
  isConfigurationValue,
  type FileExtensionManifest,
  type FileExtensionModule,
  type ExtensionContext,
  type ExtensionDocument,
  type DocumentChange,
  type VaultFolder,
  type CustomEditorProvider,
  type TextEdit,
  type CompletionItem,
  type StatusBarItem,
  type TreeItem,
  type WillSaveEvent,
} from "./index";
import { matchesDocument } from "./selectors";
import {
  UIContributionRegistry,
  type MenuContext,
  type MenuLocation,
} from "./ui-registry";
import { z } from "zod";
const completionItems = z
  .array(
    z
      .object({
        label: z.string().max(1000),
        insertText: z.string().max(100000),
        detail: z.string().max(4000).optional(),
      })
      .strict(),
  )
  .max(1000);

interface InstalledExtension {
  manifest: FileExtensionManifest;
  load(): Promise<FileExtensionModule>;
  enabled: boolean;
  builtin: boolean;
  controller?: AbortController;
  active?: Promise<void>;
  module?: FileExtensionModule;
  subscriptions: Disposable[];
}
interface Registration<T> {
  extension: string;
  value: T;
}
export interface ExtensionHostCapabilities {
  namedPaths?(): Promise<
    Array<{
      id: string;
      vault: string;
      key: string;
      path: string;
      kind: "file" | "folder";
    }>
  >;
  requestNamedPath?(
    extension: string,
    request: {
      key: string;
      path?: string;
      kind: "file" | "folder";
      title?: string;
    },
  ): Promise<boolean>;
  addNamedPath?(request: {
    vault: string;
    key: string;
    path: string;
    kind: "file" | "folder";
  }): Promise<void>;
  requestTemplate?(
    extension: string,
    request: { template: string; vault?: string },
  ): Promise<boolean>;
  log?(
    extension: string,
    level: "debug" | "info" | "warning" | "error",
    message: string,
  ): void;
  folders(): VaultFolder[];
  documents(): ExtensionDocument[];
  updateDocument(
    extension: FileExtensionManifest,
    vault: string,
    id: string,
    edits: TextEdit[],
    instance?: string,
  ): Promise<void>;
  getConfiguration(extension: string, key: string): unknown;
  updateConfiguration(
    extension: string,
    key: string,
    value: unknown,
  ): Promise<void>;
}
/** Portable host: declarations are inert; activation is explicit and lazy. */
export class FileExtensionHost {
  readonly ui = new UIContributionRegistry();
  private logBudgets = new Map<string, { time: number; count: number }>();
  writeLog(
    extension: string,
    level: "debug" | "info" | "warning" | "error",
    message: string,
  ) {
    const installed = this.require(extension);
    if (!installed.enabled) throw Error("Extension is disabled");
    if (
      !["debug", "info", "warning", "error"].includes(level) ||
      typeof message !== "string" ||
      message.length > 4000
    )
      throw Error("Invalid extension log record");
    let budget = this.logBudgets.get(extension);
    if (!budget || Date.now() - budget.time > 60000) {
      budget = { time: Date.now(), count: 0 };
      this.logBudgets.set(extension, budget);
    }
    if (++budget.count <= 120)
      this.capabilities.log?.(extension, level, message);
  }
  readonly failures = new Map<string, string>();
  private extensions = new Map<string, InstalledExtension>();
  private commands = new Map<
    string,
    Registration<(...args: unknown[]) => unknown>
  >();
  private editors = new Map<string, Registration<CustomEditorProvider>>();
  private completions = new Map<
    string,
    Registration<
      (
        doc: ExtensionDocument,
        offset: number,
        token: CancellationToken,
      ) => CompletionItem[] | Promise<CompletionItem[]>
    >
  >();
  private extractors = new Map<
    string,
    Registration<
      (
        doc: ExtensionDocument,
        token: CancellationToken,
      ) => string | Promise<string>
    >
  >();
  private trees = new Map<
    string,
    Registration<() => TreeItem[] | Promise<TreeItem[]>>
  >();
  private menusDirty = true;
  private status = new Map<string, Registration<StatusBarItem>>();
  private willSave = new Set<
    Registration<
      (event: WillSaveEvent) => TextEdit[] | void | Promise<TextEdit[] | void>
    >
  >();
  private activeDocument?: ExtensionDocument;
  private events = {
    open: new Emitter<ExtensionDocument>(),
    change: new Emitter<DocumentChange>(),
    save: new Emitter<ExtensionDocument>(),
    close: new Emitter<ExtensionDocument>(),
    folders: new Emitter<{ added: VaultFolder[]; removed: VaultFolder[] }>(),
    contributions: new Emitter<void>(),
    status: new Emitter<void>(),
    active: new Emitter<ExtensionDocument | undefined>(),
    configuration: new Emitter<void>(),
  };
  readonly onDidChangeContributions = this.events.contributions.event;
  readonly onDidChangeStatus = this.events.status.event;
  constructor(readonly capabilities: ExtensionHostCapabilities) {}
  /** Caller must verify package/publisher before supplying a loader. */
  installVerified(
    manifest: unknown,
    load: InstalledExtension["load"],
    options: { builtin?: boolean; enabled?: boolean } = {},
  ) {
    const parsed = fileExtensionManifestSchema.parse(manifest);
    if (
      !options.builtin &&
      (parsed.id === "core" || parsed.id.startsWith("core."))
    )
      throw Error("The core namespace is reserved for bundled features");
    if (this.extensions.has(parsed.id))
      throw Error(`Extension already installed: ${parsed.id}`);
    this.menusDirty = true;
    this.extensions.set(parsed.id, {
      manifest: parsed,
      load,
      enabled: options.enabled !== false,
      builtin: options.builtin === true,
      subscriptions: [],
    });
    this.events.contributions.fire();
  }
  manifests() {
    return [...this.extensions.values()]
      .filter((e) => e.enabled)
      .map((e) => e.manifest);
  }
  installed() {
    return [...this.extensions.values()].map((e) => ({
      manifest: e.manifest,
      enabled: e.enabled,
      builtin: e.builtin,
      active: Boolean(e.active),
      error: this.failures.get(e.manifest.id),
    }));
  }
  async uninstall(id: string) {
    if (this.extensions.get(id)?.builtin)
      throw Error("Bundled extensions can be disabled, not removed");
    await this.setEnabled(id, false);
    this.extensions.delete(id);
    this.menusDirty = true;
    this.ui.remove(id);
    this.events.contributions.fire();
  }
  private matches(
    extension: string,
    selector: import("./index").DocumentSelector,
    doc: Pick<ExtensionDocument, "path" | "mime" | "contentType">,
  ) {
    const manifest = this.require(extension).manifest;
    try {
      return (
        manifest.mimeTypes.some(
          (mime) =>
            mime === "*/*" ||
            mime === doc.mime ||
            (mime.endsWith("/*") && doc.mime.startsWith(mime.slice(0, -1))),
        ) && matchesDocument(selector, doc)
      );
    } catch {
      return false;
    }
  }
  editorContributions(
    doc: Pick<ExtensionDocument, "path" | "mime" | "contentType">,
  ) {
    const matches = this.manifests().flatMap((manifest) =>
      manifest.contributes.editors
        .filter(
          (editor) =>
            (!editor.requiresContentType || doc.contentType) &&
            editor.selectors.some((selector) =>
              this.matches(manifest.id, selector, doc),
            ),
        )
        .map((editor) => ({ ...editor, extension: manifest.id })),
    );
    const specialized = doc.contentType
      ? matches.filter((e) =>
          e.selectors.some((s) => s.contentType === doc.contentType),
        )
      : [];
    return [...specialized, ...matches.filter((e) => !specialized.includes(e))];
  }
  commandContributions() {
    return this.manifests().flatMap((m) =>
      m.contributes.commands.map((c) => ({ ...c, extension: m.id })),
    );
  }
  viewContributions() {
    return this.manifests().flatMap((m) =>
      m.contributes.views.map((v) => ({ ...v, extension: m.id })),
    );
  }
  menuContributions(location: MenuLocation, doc?: MenuContext) {
    if (this.menusDirty) {
      for (const installed of this.extensions.values()) {
        const m = installed.manifest;
        this.ui.replace(
          m.id,
          installed.enabled
            ? [
                ...m.contributes.menus.map((menu, index) => ({
                  ...menu,
                  group: menu.group ?? "60.extensions",
                  id: m.id + ".menu." + index,
                  when: {
                    ...menu.when,
                    ...(menu.contentType
                      ? { contentType: menu.contentType }
                      : {}),
                  },
                  title: m.contributes.commands.find(
                    (c) => c.id === menu.command,
                  )!.title,
                })),
                ...m.contributes.commands
                  .filter(
                    (command) =>
                      !m.contributes.menus.some(
                        (menu) =>
                          menu.location === "commandPalette" &&
                          menu.command === command.id,
                      ),
                  )
                  .map((command) => ({
                    id: m.id + ".palette." + command.id,
                    command: command.id,
                    title: command.title,
                    location: "commandPalette" as const,
                    group: "60.extensions",
                  })),
              ]
            : [],
        );
      }
      this.menusDirty = false;
    }
    return this.ui
      .items(location, doc)
      .map((item) => ({ ...item, extension: item.owner }));
  }
  configurationContributions() {
    return this.manifests().flatMap((m) =>
      m.contributes.configuration.map((c) => ({ ...c, extension: m.id })),
    );
  }
  configurationValue(extension: string, key: string) {
    const declaration = this.require(
      extension,
    ).manifest.contributes.configuration.find((c) => c.key === key);
    if (!declaration) throw Error("Undeclared configuration key");
    const value = this.capabilities.getConfiguration(extension, key);
    return isConfigurationValue(declaration.type, value)
      ? value
      : declaration.default;
  }
  didChangeConfiguration() {
    this.events.configuration.fire();
  }
  statusItems() {
    return [...this.status.values()]
      .map((s) => s.value)
      .sort(
        (a, b) =>
          (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id),
      );
  }
  private require(id: string) {
    const e = this.extensions.get(id);
    if (!e?.enabled) throw Error(`Extension is disabled: ${id}`);
    return e;
  }
  private register<T>(
    extension: InstalledExtension,
    map: Map<string, Registration<T>>,
    id: string,
    value: T,
    declared: { id: string }[],
  ) {
    if (
      extension.controller?.signal.aborted ||
      !declared.some((d) => d.id === id)
    )
      throw Error(`Undeclared contribution: ${id}`);
    if (map.has(id)) throw Error(`Contribution already registered: ${id}`);
    const entry = { extension: extension.manifest.id, value };
    map.set(id, entry);
    this.events.contributions.fire();
    const disposable = Disposable.create(() => {
      if (map.get(id) === entry) {
        map.delete(id);
        this.events.contributions.fire();
      }
    });
    extension.subscriptions.push(disposable);
    return disposable;
  }
  private context(
    extension: InstalledExtension,
    controller: AbortController,
  ): ExtensionContext {
    const host = this,
      manifest = extension.manifest,
      declarations = manifest.contributes;
    const active = () => {
      if (
        !extension.enabled ||
        controller.signal.aborted ||
        extension.controller !== controller
      )
        throw Error("Extension has been disabled");
    };
    const documentAllowed = (doc: ExtensionDocument) =>
      declarations.editors.some(
        (e) =>
          (!e.requiresContentType || doc.contentType) &&
          e.selectors.some((s) => host.matches(manifest.id, s, doc)),
      ) ||
      [
        ...declarations.completion,
        ...declarations.search,
        ...declarations.documentObservers,
      ].some((p) => p.selectors.some((s) => host.matches(manifest.id, s, doc)));
    const writeAllowed = (doc: ExtensionDocument) =>
      declarations.editors.some(
        (e) =>
          (!e.requiresContentType || doc.contentType) &&
          e.selectors.some((s) => host.matches(manifest.id, s, doc)),
      ) ||
      declarations.documentObservers.some((p) =>
        p.selectors.some((s) => host.matches(manifest.id, s, doc)),
      );
    const trackEvent =
      <T>(
        event: import("vscode-jsonrpc").Event<T>,
        filter: (value: T) => boolean,
      ): import("vscode-jsonrpc").Event<T> =>
      (listener, thisArg, disposables) => {
        active();
        const d = event((value) => {
          if (
            extension.enabled &&
            extension.controller === controller &&
            !controller.signal.aborted &&
            filter(value)
          )
            listener.call(thisArg, value);
        });
        extension.subscriptions.push(d);
        disposables?.push(d);
        return d;
      };
    return {
      extension: manifest,
      logger: {
        log: (level, message) => {
          active();
          this.writeLog(manifest.id, level, message);
        },
      },
      subscriptions: extension.subscriptions,
      signal: controller.signal,
      commands: {
        registerCommand: (id, handler) => {
          active();
          return this.register(
            extension,
            this.commands,
            id,
            handler,
            declarations.commands,
          );
        },
        executeCommand: async (id, ...args) => {
          active();
          if (!declarations.commands.some((c) => c.id === id))
            throw Error("An extension may execute only its declared commands");
          return this.executeCommand(id, ...args);
        },
      },
      editors: {
        registerCustomEditorProvider: (id, provider) => {
          active();
          return this.register(
            extension,
            this.editors,
            id,
            provider,
            declarations.editors,
          );
        },
      },
      workspace: {
        namedPaths: async () => {
          active();
          return host.capabilities.namedPaths?.() ?? [];
        },
        requestNamedPath: async (request) => {
          active();
          if (!host.capabilities.requestNamedPath)
            throw Error("Named path prompts are unavailable");
          return host.capabilities.requestNamedPath(manifest.id, request);
        },
        addNamedPath: async (request) => {
          active();
          if (!host.capabilities.addNamedPath)
            throw Error("Named paths are unavailable");
          await host.capabilities.addNamedPath(request);
        },
        requestTemplate: async (request) => {
          active();
          if (
            !declarations.templates.some(
              (template) => template.id === request.template,
            )
          )
            throw Error("Template is not declared by this plugin");
          if (!host.capabilities.requestTemplate)
            throw Error("Template prompts are unavailable");
          return host.capabilities.requestTemplate(manifest.id, request);
        },
        get folders() {
          active();
          return host.capabilities.folders();
        },
        get documents() {
          active();
          return host.capabilities.documents().filter(documentAllowed);
        },
        onDidOpenDocument: trackEvent(this.events.open.event, documentAllowed),
        onDidChangeDocument: trackEvent(this.events.change.event, (e) =>
          documentAllowed(e.document),
        ),
        onDidSaveDocument: trackEvent(this.events.save.event, documentAllowed),
        onDidCloseDocument: trackEvent(
          this.events.close.event,
          documentAllowed,
        ),
        onDidChangeVaultFolders: trackEvent(
          this.events.folders.event,
          () => true,
        ),
        onWillSaveDocument: (handler) => {
          active();
          const entry = { extension: manifest.id, value: handler };
          this.willSave.add(entry);
          const disposable = Disposable.create(() =>
            this.willSave.delete(entry),
          );
          extension.subscriptions.push(disposable);
          return disposable;
        },
        updateDocument: async (vault, id, edits, instance) => {
          active();
          const doc = host.capabilities
            .documents()
            .find(
              (d) =>
                d.vault === vault &&
                d.id === id &&
                d.instance ===
                  (instance ??
                    (host.activeDocument?.vault === vault &&
                    host.activeDocument.id === id
                      ? host.activeDocument.instance
                      : undefined)),
            );
          if (!doc || !writeAllowed(doc))
            throw Error("File is outside the extension's content contract");
          await this.capabilities.updateDocument(
            manifest,
            vault,
            id,
            edits,
            doc.instance,
          );
        },
      },
      languages: {
        registerCompletionProvider: (id, provider) => {
          active();
          return this.register(
            extension,
            this.completions,
            id,
            provider,
            declarations.completion,
          );
        },
      },
      search: {
        registerTextExtractor: (id, provider) => {
          active();
          return this.register(
            extension,
            this.extractors,
            id,
            provider,
            declarations.search,
          );
        },
      },
      window: {
        get activeDocument() {
          return host.activeDocument && documentAllowed(host.activeDocument)
            ? structuredClone(host.activeDocument)
            : undefined;
        },
        onDidChangeActiveEditor: (listener, thisArg, disposables) => {
          active();
          const d = this.events.active.event((doc) => {
            if (
              extension.controller === controller &&
              !controller.signal.aborted
            )
              listener.call(
                thisArg,
                doc && documentAllowed(doc) ? doc : undefined,
              );
          });
          extension.subscriptions.push(d);
          disposables?.push(d);
          return d;
        },
        registerTreeDataProvider: (id, provider) => {
          active();
          return this.register(
            extension,
            this.trees,
            id,
            provider,
            declarations.views,
          );
        },
        setStatusBarItem: (item) => {
          active();
          if (
            !item.id.startsWith(manifest.id + ".") ||
            (item.command &&
              !declarations.commands.some((c) => c.id === item.command))
          )
            throw Error("Status item must use extension namespace");
          const entry = { extension: manifest.id, value: item };
          this.status.set(item.id, entry);
          this.events.status.fire();
          return Disposable.create(() => {
            if (this.status.get(item.id) === entry) {
              this.status.delete(item.id);
              this.events.status.fire();
            }
          });
        },
      },
      configuration: {
        onDidChange: trackEvent(this.events.configuration.event, () => true),
        get: <T>(key: string) => {
          active();
          const declaration = declarations.configuration.find(
            (c) => c.key === key,
          );
          if (!declaration) throw Error("Undeclared configuration key");
          return this.configurationValue(manifest.id, key) as T;
        },
        update: async (key, value) => {
          active();
          const declaration = declarations.configuration.find(
            (c) => c.key === key,
          );
          if (!declaration || !isConfigurationValue(declaration.type, value))
            throw Error("Invalid configuration value");
          await this.capabilities.updateConfiguration(manifest.id, key, value);
        },
      },
    };
  }
  activate(id: string): Promise<void> {
    const extension = this.require(id);
    if (extension.active) return extension.active;
    const controller = (extension.controller = new AbortController()),
      subscriptions: Disposable[] = [];
    extension.subscriptions = subscriptions;
    extension.active = (async () => {
      try {
        const module = await extension.load();
        if (extension.controller !== controller || controller.signal.aborted)
          throw Error("Extension activation was cancelled");
        extension.module = module;
        await module.activate(this.context(extension, controller));
        if (extension.controller === controller) this.failures.delete(id);
      } catch (error) {
        controller.abort();
        subscriptions
          .splice(0)
          .reverse()
          .forEach((d) => d.dispose());
        if (extension.controller === controller) {
          this.failures.set(id, String(error));
          extension.active = undefined;
          this.events.contributions.fire();
        }
        throw error;
      }
    })();
    return extension.active;
  }
  async activateEvent(event: string) {
    await Promise.all(
      this.manifests()
        .filter((m) => m.activationEvents.includes(event))
        .map((m) => this.activate(m.id)),
    );
  }
  async executeCommand(id: string, ...args: unknown[]) {
    const declaration = this.commandContributions().find((c) => c.id === id);
    if (!declaration) throw Error("Unknown extension command");
    await this.activate(declaration.extension);
    const command = this.commands.get(id);
    if (!command) throw Error("Extension did not register its command");
    return boundedProvider(
      () => command.value(...args),
      CancellationToken.None,
      10000,
    );
  }
  async resolveEditor(
    id: string,
    doc: ExtensionDocument,
    token = CancellationToken.None,
  ) {
    const contribution = this.editorContributions(doc).find((e) => e.id === id);
    if (!contribution) throw Error("Editor does not support this file");
    await this.activate(contribution.extension);
    const provider = this.editors.get(id);
    if (!provider) throw Error("Extension did not register its editor");
    const presentation = await provider.value.resolve(doc, token);
    if (
      presentation.kind === "component" &&
      !this.require(contribution.extension).builtin
    )
      throw Error("External editors must use isolated webviews");
    return presentation;
  }
  async willSaveDocument(doc: ExtensionDocument): Promise<TextEdit[]> {
    const source = new CancellationTokenSource(),
      edits: TextEdit[] = [];
    const timer = setTimeout(() => source.cancel(), 3000);
    try {
      for (const hook of this.willSave) {
        const declarations = this.require(hook.extension).manifest.contributes;
        if (
          !declarations.editors.some(
            (e) =>
              (!e.requiresContentType || doc.contentType) &&
              e.selectors.some((s) => this.matches(hook.extension, s, doc)),
          ) &&
          !declarations.documentObservers.some((p) =>
            p.selectors.some((s) => this.matches(hook.extension, s, doc)),
          )
        )
          continue;
        const result = await Promise.race([
          Promise.resolve(hook.value({ document: doc, token: source.token })),
          new Promise<never>((_, reject) => {
            const d = source.token.onCancellationRequested(() => {
              d.dispose();
              reject(Error("Extension save hook timed out"));
            });
          }),
        ]);
        if (result && this.willSave.has(hook)) edits.push(...result);
      }
      return edits;
    } finally {
      clearTimeout(timer);
      source.dispose();
    }
  }
  didOpenDocument(doc: ExtensionDocument) {
    this.events.open.fire(doc);
  }
  didChangeActiveEditor(doc: ExtensionDocument | undefined) {
    if (
      this.activeDocument?.vault === doc?.vault &&
      this.activeDocument?.id === doc?.id &&
      this.activeDocument?.instance === doc?.instance &&
      this.activeDocument?.version === doc?.version
    )
      return;
    this.activeDocument = doc;
    this.events.active.fire(doc);
  }
  didChangeDocument(change: DocumentChange) {
    if (
      this.activeDocument?.id === change.document.id &&
      this.activeDocument.vault === change.document.vault &&
      this.activeDocument.instance === change.document.instance
    )
      this.activeDocument = change.document;
    this.events.change.fire(change);
  }
  didSaveDocument(doc: ExtensionDocument) {
    this.events.save.fire(doc);
  }
  didCloseDocument(doc: ExtensionDocument) {
    if (
      this.activeDocument?.id === doc.id &&
      this.activeDocument.vault === doc.vault &&
      this.activeDocument.instance === doc.instance
    )
      this.didChangeActiveEditor(undefined);
    this.events.close.fire(doc);
  }
  didChangeVaultFolders(added: VaultFolder[], removed: VaultFolder[]) {
    this.events.folders.fire({ added, removed });
  }
  async completionsFor(
    doc: ExtensionDocument,
    offset: number,
    token = CancellationToken.None,
  ) {
    const result: CompletionItem[] = [];
    for (const m of this.manifests())
      for (const declaration of m.contributes.completion.filter((c) =>
        c.selectors.some((s) => this.matches(m.id, s, doc)),
      )) {
        await this.activate(m.id);
        if (token.isCancellationRequested) return [];
        const provider = this.completions.get(declaration.id);
        if (provider)
          result.push(
            ...completionItems.parse(
              await boundedProvider(
                (t) => provider.value(doc, offset, t),
                token,
              ),
            ),
          );
      }
    return result;
  }
  async extractText(doc: ExtensionDocument, token = CancellationToken.None) {
    const result: string[] = [];
    for (const m of this.manifests())
      for (const declaration of m.contributes.search.filter((c) =>
        c.selectors.some((s) => this.matches(m.id, s, doc)),
      )) {
        await this.activate(m.id);
        const provider = this.extractors.get(declaration.id);
        if (provider)
          result.push(
            z
              .string()
              .max(5 * 1024 * 1024)
              .parse(
                await boundedProvider((t) => provider.value(doc, t), token),
              ),
          );
      }
    return result.join("\n");
  }
  async treeItems(id: string) {
    const declared = this.viewContributions().find((v) => v.id === id);
    if (!declared) throw Error("Unknown extension view");
    await this.activate(declared.extension);
    const items =
      (await boundedProvider(() => this.trees.get(id)?.value() ?? [])) ?? [];
    const allowed = this.require(declared.extension).manifest.contributes
      .commands;
    const validate = (items: TreeItem[], depth = 0) => {
      if (!Array.isArray(items) || items.length > 1000 || depth > 20)
        throw Error("Extension tree exceeds limits");
      const ids = new Set<string>();
      for (const item of items) {
        if (
          typeof item.id !== "string" ||
          typeof item.label !== "string" ||
          item.label.length > 4000 ||
          ids.has(item.id) ||
          (item.command && !allowed.some((c) => c.id === item.command))
        )
          throw Error("Invalid extension tree item");
        ids.add(item.id);
        if (item.children) validate(item.children, depth + 1);
      }
    };
    validate(items);
    return items;
  }
  async setEnabled(id: string, enabled: boolean) {
    const extension = this.extensions.get(id);
    if (!extension) throw Error("Unknown extension");
    extension.enabled = enabled;
    this.menusDirty = true;
    if (!enabled) {
      const module = extension.module;
      extension.controller?.abort();
      extension.subscriptions
        .splice(0)
        .reverse()
        .forEach((d) => d.dispose());
      extension.active = undefined;
      extension.module = undefined;
      for (const [key, item] of this.status)
        if (item.extension === id) this.status.delete(key);
      this.events.status.fire();
      await module?.deactivate?.();
    }
    this.events.contributions.fire();
  }
  async dispose() {
    for (const id of this.extensions.keys()) await this.setEnabled(id, false);
    Object.values(this.events).forEach((e) => e.dispose());
  }
}

async function boundedProvider<T>(
  run: (token: CancellationToken) => T | Promise<T>,
  parent = CancellationToken.None,
  timeout = 3000,
): Promise<T> {
  const source = new CancellationTokenSource(),
    parentSubscription = parent.onCancellationRequested(() => source.cancel());
  if (parent.isCancellationRequested) source.cancel();
  let subscription: Disposable | undefined;
  const timer = setTimeout(() => source.cancel(), timeout);
  try {
    if (source.token.isCancellationRequested)
      throw Error("Extension request cancelled");
    return await Promise.race([
      Promise.resolve(run(source.token)),
      new Promise<never>((_, reject) => {
        subscription = source.token.onCancellationRequested(() =>
          reject(Error("Extension request cancelled or timed out")),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    subscription?.dispose();
    parentSubscription.dispose();
    source.dispose();
  }
}

/** Apply ranges together, rejecting overlap and invalid offsets before mutating. */
export function applyTextEdits(text: string, edits: TextEdit[]) {
  let boundary = text.length,
    result = text;
  for (const edit of [...edits].sort(
    (a, b) => b.from - a.from || b.to - a.to,
  )) {
    if (
      !Number.isSafeInteger(edit.from) ||
      !Number.isSafeInteger(edit.to) ||
      edit.from < 0 ||
      edit.to < edit.from ||
      edit.to > boundary ||
      typeof edit.insert !== "string"
    )
      throw Error("Invalid or overlapping text edits");
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
    boundary = edit.from;
  }
  return result;
}
