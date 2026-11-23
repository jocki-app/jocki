import { useState } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { useLiveQuery } from "../data-duckdb/react";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../ui/primitives/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "../ui/primitives/command";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/primitives/dialog";
import { notify } from "../ui/notifications";
import {
  createSchema,
  schemaDefinitions,
  selectedSchema,
  tableSelectionKey,
} from "./collection-tables";
import type { AppRuntime } from "./runtime";

export function SchemaPicker({
  runtime,
  footer = false,
}: {
  runtime: AppRuntime;
  footer?: boolean;
}) {
  const definitions =
    useLiveQuery(() => schemaDefinitions(runtime), [runtime]) ?? [];
  const selected = useLiveQuery(() => selectedSchema(runtime), [runtime]);
  const [open, setOpen] = useState(false),
    [creating, setCreating] = useState(false),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false);
  const select = async (id: string) => {
    await runtime.db.setMetadata(tableSelectionKey(), id);
    setOpen(false);
  };
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              role="combobox"
              aria-label="Schema"
              className={
                footer
                  ? "w-full justify-between"
                  : "h-auto max-w-48 px-1 py-0 text-inherit"
              }
            />
          }
        >
          <span className="truncate">
            {footer && "Schema: "}
            {String(selected?.data.name ?? "Default")}
          </span>
          <ChevronDown className="size-3" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          <Command>
            <CommandInput placeholder="Find schema…" />
            <CommandList className="mt-2">
              <CommandEmpty>No schemas found.</CommandEmpty>
              {definitions.map((schema) => (
                <CommandItem
                  key={schema.id}
                  value={schema.id + " " + schema.data.name}
                  onSelect={() => void select(schema.id).catch(notify.error)}
                >
                  <span className="flex-1 truncate">
                    {String(schema.data.name)}
                  </span>
                  {selected?.id === schema.id && <Check className="size-4" />}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
          <div className="border-t p-1">
            <Button
              variant="ghost"
              className="w-full justify-start"
              disabled={!runtime.node.records.canWrite()}
              onClick={() => {
                setOpen(false);
                setCreating(true);
              }}
            >
              <Plus />
              New schema
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create schema</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy || !name.trim()) return;
              setBusy(true);
              try {
                const schema = await createSchema(runtime, name);
                await select(schema.id);
                setCreating(false);
                setName("");
                notify.success("Schema created.");
              } catch (e) {
                notify.error(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field-row">
              Schema name
              <Input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <Button type="submit" disabled={busy || !name.trim()}>
              Create schema
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
