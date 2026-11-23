import { useEffect, useRef, useState } from "react";
import { Save, HardDrive, CloudUpload, CircleAlert } from "lucide-react";
import { Button } from "./primitives/button";
import { Textarea } from "./primitives/textarea";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
} from "./primitives/popover";
import { notify } from "./notifications";

/** Explicit save with durable status; a held click opens the native history message input. */
export function SaveStatusButton({
  dirty,
  saving = false,
  disabled = false,
  canDescribe = false,
  label = "Save",
  onSave,
}: {
  dirty: boolean;
  saving?: boolean;
  disabled?: boolean;
  canDescribe?: boolean;
  label?: string;
  onSave(description?: string): Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [describe, setDescribe] = useState(false),
    [description, setDescription] = useState(""),
    [pending, setPending] = useState(false),
    [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    held = useRef(false),
    start = useRef({ x: 0, y: 0 });
  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => cancel, []);
  useEffect(() => {
    if (!dirty) setFailed(false);
  }, [dirty]);
  const busy = saving || pending;
  const openDescription = () => {
    setDescribe(true);
    setOpen(true);
  };
  const status = busy
    ? "Saving changes"
    : failed
      ? "Save failed"
      : dirty
        ? "Unsaved changes"
        : "Saved on this device";
  const commit = async (message?: string) => {
    setPending(true);
    setFailed(false);
    try {
      await onSave(message);
      setOpen(false);
      setDescription("");
    } catch (error) {
      setFailed(true);
      notify.error(error);
    } finally {
      setPending(false);
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (details.reason !== "trigger-press") setOpen(next);
      }}
    >
      <PopoverTrigger
        render={<Button variant="ghost" size="icon-sm" />}
        aria-label={dirty || failed ? label : `${label}: ${status}`}
        title={`${status}${canDescribe ? ". Hold to add a version description" : ""}`}
        data-save-state={
          busy ? "saving" : failed ? "error" : dirty ? "dirty" : "saved"
        }
        disabled={disabled || busy}
        onPointerDown={(event) => {
          if (event.button !== 0 || disabled || busy) return;
          held.current = false;
          start.current = { x: event.clientX, y: event.clientY };
          cancel();
          if (canDescribe)
            timer.current = setTimeout(() => {
              held.current = true;
              openDescription();
            }, 500);
        }}
        onPointerMove={(event) => {
          if (
            Math.hypot(
              event.clientX - start.current.x,
              event.clientY - start.current.y,
            ) > 10
          )
            cancel();
        }}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onPointerLeave={cancel}
        onContextMenu={(event) => {
          if (canDescribe) {
            event.preventDefault();
            cancel();
            openDescription();
          }
        }}
        onKeyDown={(event) => {
          if (canDescribe && event.altKey && event.key === "ArrowDown") {
            event.preventDefault();
            openDescription();
          }
        }}
        onClick={(event) => {
          event.preventDefault();
          if (held.current) {
            held.current = false;
            return;
          }
          if (dirty || failed) void commit();
          else {
            setDescribe(false);
            setOpen(true);
          }
        }}
      >
        {busy ? (
          <CloudUpload className="animate-pulse" />
        ) : failed ? (
          <CircleAlert className="text-destructive" />
        ) : dirty ? (
          <Save />
        ) : (
          <HardDrive />
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)]"
        aria-label={describe ? "Save version" : "File storage"}
      >
        <PopoverTitle>
          {describe ? "Save version" : "File storage"}
        </PopoverTitle>
        <p className="mt-1 text-xs text-muted-foreground" role="status">
          {status}
        </p>
        {!describe && (
          <p className="text-xs text-muted-foreground">
            Local storage does not confirm another device has received this
            version.
          </p>
        )}
        {canDescribe && describe && (
          <form
            className="mt-3 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (description.trim() && !busy) void commit(description);
            }}
          >
            <label className="block space-y-2 text-sm">
              Description
              <Textarea
                aria-label="Version description"
                maxLength={2000}
                rows={2}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={busy}
                autoFocus
                placeholder="Describe this version…"
              />
            </label>
            <Button
              type="submit"
              size="sm"
              disabled={busy || !description.trim()}
            >
              Save version
            </Button>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}
