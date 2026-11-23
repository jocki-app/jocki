import { useOptimisticRecords } from "../ui/optimistic";
import { CloudUpload, HardDrive } from "lucide-react";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import type { AppRuntime } from "./runtime";
import { Button } from "../ui/primitives/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/primitives/popover";
export function RecordSyncStatus({
  runtime,
  record,
}: {
  runtime: AppRuntime;
  record: ResourceRecord;
}) {
  const pending = useOptimisticRecords(runtime.optimistic).count(record.id);
  const label = pending ? "Saving changes" : "Saved on this device";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            title={label}
          />
        }
      >
        {pending ? <CloudUpload className="animate-pulse" /> : <HardDrive />}
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <PopoverTitle>Item storage</PopoverTitle>
        <p>{label}</p>
        <p className="text-sm text-muted-foreground">
          Automerge Repo synchronizes this workspace with connected peers. Local
          persistence does not confirm another device has received a change.
        </p>
      </PopoverContent>
    </Popover>
  );
}
