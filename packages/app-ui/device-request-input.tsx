import { notify } from "../ui/notifications";
import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { LegacySelect } from "../ui/choice-select";
import { readDeviceRequest, type DeviceRequestOptions } from "../core/pairing";

export function DeviceRequestInput({
  value,
  label = "Device request",
}: {
  value: string;
  label?: string;
}) {
  const id = useId(),
    input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false),
    [name, setName] = useState<string>(),
    [access, setAccess] = useState<DeviceRequestOptions["access"]>();
  let parsed: ReturnType<typeof readDeviceRequest> | undefined;
  try {
    if (value) parsed = readDeviceRequest(value);
  } catch {}
  const deviceName = name ?? parsed?.identity.name ?? "";
  const requestedAccess = access ?? parsed?.access ?? "write";
  const request =
    parsed && deviceName.trim()
      ? JSON.stringify({
          ...parsed,
          identity: { ...parsed.identity, name: deviceName },
          access: requestedAccess,
        })
      : "";
  useEffect(() => {
    setCopied(false);
  }, [value]);
  useEffect(() => setCopied(false), [request]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try {
      try {
        await navigator.clipboard.writeText(request);
      } catch {
        input.current?.focus();
        input.current?.select();
        if (!document.execCommand("copy")) throw new Error("Copy unavailable");
      }
      setCopied(true);
      notify.success("Device request copied.");
    } catch {
      notify.error("Select and copy the device request manually.");
    }
  }
  return (
    <div className="space-y-3 min-w-0">
      <label className="field-row">
        Device name
        <Input
          value={deviceName}
          maxLength={128}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="field-row">
        Access
        <LegacySelect
          aria-label="Access"
          value={requestedAccess}
          onChange={(event) =>
            setAccess(event.target.value as DeviceRequestOptions["access"])
          }
        >
          <option value="write">Write</option>
          <option value="read">Read</option>
        </LegacySelect>
      </label>
      <div className="field-row">
        <label htmlFor={id}>Device request</label>
        <div className="flex min-w-0 max-w-full">
          <Input
            ref={input}
            id={id}
            aria-label={label}
            readOnly
            value={request}
            onFocus={(event) => event.target.select()}
            className="w-0 min-w-0 flex-1 rounded-r-none font-mono"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0 rounded-l-none border-l-0"
            aria-label="Copy device request"
            title={copied ? "Copied" : "Copy device request"}
            disabled={!request}
            onClick={() => void copy()}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
      </div>
      <span className="sr-only" role="status">
        {copied ? "Device request copied" : ""}
      </span>
    </div>
  );
}
