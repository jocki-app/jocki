import { z } from "zod";
import { menuLocations } from "./ui-registry";
export {
  UIContributionRegistry,
  menuLocations,
  type MenuContext,
  type MenuLocation,
  type MenuContribution,
} from "./ui-registry";
export {
  Disposable,
  Emitter,
  type Event,
  type CancellationToken,
} from "vscode-jsonrpc";
import type { Disposable, Event, CancellationToken } from "vscode-jsonrpc";

const id = z.string().regex(/^[a-z][a-z0-9.-]*$/);
export function isConfigurationValue(type: string, value: unknown) {
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === type && (type !== "number" || Number.isFinite(value));
}
export const selectorSchema = z
  .object({
    mime: z.string().optional(),
    pattern: z.string().max(512).optional(),
    contentType: z.string().optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.mime || v.pattern || v.contentType),
    "A selector needs a MIME type, pattern, or content type",
  );
export type DocumentSelector = z.infer<typeof selectorSchema>;
export const fileExtensionManifestSchema = z
  .object({
    api: z.literal("jocki-extensions/1"),
    id,
    name: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    publisher: z.string().min(1),
    license: z.string().min(1),
    description: z.string().default(""),
    mimeTypes: z
      .array(z.string().regex(/^(?:\*|[\w.+-]+)\/(?:\*|[\w.+-]+)$/))
      .nonempty(),
    contentTypes: z.array(z.string().min(1)).default([]),
    entrypoints: z
      .object({
        browser: z.string().optional(),
        workspace: z.string().optional(),
        native: z.string().optional(),
      })
      .strict(),
    extensionKind: z
      .array(z.enum(["ui", "workspace"]))
      .nonempty()
      .default(["ui"]),
    activationEvents: z
      .array(
        z
          .string()
          .regex(
            /^(onStartupFinished|onVaultOpen|onEditor:[a-z0-9.-]+|onCommand:[a-z0-9.-]+|onView:[a-z0-9.-]+|onContentType:[a-z0-9.-]+)$/,
          ),
      )
      .default([]),
    capabilities: z
      .object({
        vaultRead: z.boolean().default(false),
        native: z.array(z.string()).default([]),
      })
      .strict()
      .prefault({}),
    contributes: z
      .object({
        editors: z
          .array(
            z
              .object({
                id,
                title: z.string(),
                selectors: z.array(selectorSchema).nonempty(),
                requiresContentType: z.boolean(),
                priority: z.enum(["default", "optional"]).default("default"),
                icon: z.string().max(50).optional(),
              })
              .strict(),
          )
          .default([]),
        commands: z
          .array(
            z
              .object({
                id,
                title: z.string(),
                category: z.string().optional(),
              })
              .strict(),
          )
          .default([]),
        menus: z
          .array(
            z
              .object({
                location: z.enum(menuLocations),
                command: id,
                popover: z
                  .object({
                    title: z.string().optional(),
                    items: z
                      .array(
                        z
                          .object({
                            command: id,
                            title: z.string(),
                            icon: z.string().optional(),
                          })
                          .strict(),
                      )
                      .max(100),
                  })
                  .strict()
                  .optional(),
                contentType: z.string().optional(),
                icon: z.string().max(50).optional(),
                group: z.string().max(100).optional(),
                order: z.number().finite().optional(),
                when: z
                  .object({
                    kinds: z
                      .array(z.enum(["workspace", "vault", "folder", "file"]))
                      .optional(),
                    mime: z.string().optional(),
                    contentType: z.string().optional(),
                    history: z.boolean().optional(),
                    sync: z.boolean().optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          )
          .default([]),
        keybindings: z
          .array(z.object({ command: id, key: z.string().min(1) }).strict())
          .default([]),
        views: z
          .array(
            z
              .object({
                id,
                title: z.string(),
                location: z.enum(["sidebar", "panel", "navigation"]),
                icon: z.string().max(50).optional(),
              })
              .strict(),
          )
          .default([]),
        templates: z
          .array(
            z
              .object({
                id,
                title: z.string().min(1).max(200),
                extension: z.string().regex(/^\.[a-z0-9]+$/),
                contentType: z.string().optional(),
                text: z.string().max(200000).optional(),
                file: z.string().min(1).max(512).optional(),
              })
              .strict()
              .refine(
                (template) =>
                  (template.text !== undefined) !==
                  (template.file !== undefined),
                "A template requires exactly one of text or file",
              ),
          )
          .max(100)
          .default([]),
        configuration: z
          .array(
            z
              .object({
                key: id,
                title: z.string(),
                type: z.enum([
                  "string",
                  "number",
                  "boolean",
                  "object",
                  "array",
                ]),
                default: z.unknown(),
                scope: z.enum(["workspace", "computer"]).default("workspace"),
              })
              .strict(),
          )
          .default([]),
        completion: z
          .array(
            z
              .object({
                id,
                selectors: z.array(selectorSchema).nonempty(),
                triggerCharacters: z.array(z.string()).default([]),
              })
              .strict(),
          )
          .default([]),
        search: z
          .array(
            z
              .object({ id, selectors: z.array(selectorSchema).nonempty() })
              .strict(),
          )
          .default([]),
        documentObservers: z
          .array(
            z
              .object({ id, selectors: z.array(selectorSchema).nonempty() })
              .strict(),
          )
          .default([]),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    for (const [kind, entries] of Object.entries(manifest.contributes)) {
      if (["menus", "keybindings"].includes(kind)) continue;
      const names = (entries as { id?: string; key?: string }[]).map(
        (e) => e.id ?? e.key!,
      );
      if (new Set(names).size !== names.length)
        ctx.addIssue({
          code: "custom",
          message: `Duplicate ${kind} contribution`,
        });
      for (const name of names)
        if (!name.startsWith(manifest.id + "."))
          ctx.addIssue({
            code: "custom",
            message: `Contribution ${name} must use the extension namespace`,
          });
    }
    const commands = new Set(manifest.contributes.commands.map((c) => c.id));
    for (const menu of manifest.contributes.menus)
      for (const item of menu.popover?.items ?? [])
        if (!commands.has(item.command))
          ctx.addIssue({
            code: "custom",
            message: `Undeclared popover command ${item.command}`,
          });
    for (const entry of [
      ...manifest.contributes.menus,
      ...manifest.contributes.keybindings,
    ])
      if (!commands.has(entry.command))
        ctx.addIssue({
          code: "custom",
          message: `Undeclared command ${entry.command}`,
        });
    for (const setting of manifest.contributes.configuration)
      if (!isConfigurationValue(setting.type, setting.default))
        ctx.addIssue({
          code: "custom",
          message: `Invalid default for configuration ${setting.key}`,
        });
  });
export type FileExtensionManifest = z.infer<typeof fileExtensionManifestSchema>;
export interface ExtensionDocument {
  vault: string;
  id: string;
  path: string;
  mime: string;
  contentType: string | null;
  text: string;
  bytes: Uint8Array;
  dirty: boolean;
  version: number;
  resource?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  /** Independent draft identity when a file is open in more than one view. */
  instance?: string;
}
export interface DocumentChange {
  document: ExtensionDocument;
  reason: "edit" | "remote" | "discard" | "save" | "template";
}
export interface VaultFolder {
  id: string;
  name: string;
}
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}
export interface WillSaveEvent {
  document: ExtensionDocument;
  token: CancellationToken;
}
export interface CompletionItem {
  label: string;
  insertText: string;
  detail?: string;
}
export interface TreeItem {
  id: string;
  label: string;
  description?: string;
  command?: string;
  children?: TreeItem[];
}
export interface StatusBarItem {
  id: string;
  text: string;
  tooltip?: string;
  command?: string;
  alignment?: "left" | "right";
  priority?: number;
}
export type EditorPresentation =
  { kind: "webview"; html: string } | { kind: "component"; component: string };
export interface CustomEditorProvider {
  resolve(
    document: ExtensionDocument,
    token: CancellationToken,
  ): EditorPresentation | Promise<EditorPresentation>;
}
export interface ExtensionContext {
  logger: {
    log(level: "debug" | "info" | "warning" | "error", message: string): void;
  };
  readonly extension: FileExtensionManifest;
  readonly subscriptions: Disposable[];
  readonly signal: AbortSignal;
  commands: {
    registerCommand(
      id: string,
      handler: (...args: unknown[]) => unknown | Promise<unknown>,
    ): Disposable;
    executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
  };
  editors: {
    registerCustomEditorProvider(
      id: string,
      provider: CustomEditorProvider,
    ): Disposable;
  };
  workspace: {
    namedPaths(): Promise<
      Array<{
        id: string;
        vault: string;
        key: string;
        path: string;
        kind: "file" | "folder";
      }>
    >;
    requestNamedPath(request: {
      key: string;
      path?: string;
      kind: "file" | "folder";
      title?: string;
    }): Promise<boolean>;
    addNamedPath(request: {
      vault: string;
      key: string;
      path: string;
      kind: "file" | "folder";
    }): Promise<void>;
    requestTemplate(request: {
      template: string;
      vault?: string;
    }): Promise<boolean>;
    readonly folders: readonly VaultFolder[];
    readonly documents: readonly ExtensionDocument[];
    readonly onDidOpenDocument: Event<ExtensionDocument>;
    readonly onDidChangeDocument: Event<DocumentChange>;
    readonly onDidSaveDocument: Event<ExtensionDocument>;
    readonly onDidCloseDocument: Event<ExtensionDocument>;
    readonly onDidChangeVaultFolders: Event<{
      added: VaultFolder[];
      removed: VaultFolder[];
    }>;
    onWillSaveDocument(
      handler: (
        event: WillSaveEvent,
      ) => TextEdit[] | void | Promise<TextEdit[] | void>,
    ): Disposable;
    updateDocument(
      vault: string,
      id: string,
      edits: TextEdit[],
      instance?: string,
    ): Promise<void>;
  };
  languages: {
    registerCompletionProvider(
      id: string,
      provider: (
        document: ExtensionDocument,
        offset: number,
        token: CancellationToken,
      ) => CompletionItem[] | Promise<CompletionItem[]>,
    ): Disposable;
  };
  search: {
    registerTextExtractor(
      id: string,
      provider: (
        document: ExtensionDocument,
        token: CancellationToken,
      ) => string | Promise<string>,
    ): Disposable;
  };
  window: {
    readonly activeDocument: ExtensionDocument | undefined;
    readonly onDidChangeActiveEditor: Event<ExtensionDocument | undefined>;
    registerTreeDataProvider(
      id: string,
      provider: () => TreeItem[] | Promise<TreeItem[]>,
    ): Disposable;
    setStatusBarItem(item: StatusBarItem): Disposable;
  };
  configuration: {
    readonly onDidChange: Event<void>;
    get<T>(key: string): T;
    update(key: string, value: unknown): Promise<void>;
  };
}
export interface FileExtensionModule {
  activate(context: ExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
