import { useState } from "react";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { Textarea } from "../ui/primitives/textarea";
import { DeviceRequestInput } from "./device-request-input";
import type { JoinDestination } from "./runtime";
export function JoinWorkspaceForm({
  request,
  disabled,
  onJoin,
}: {
  request: string;
  disabled: boolean;
  destinations?: JoinDestination["kind"][];
  onJoin(invitation: string, destination: JoinDestination): Promise<void>;
}) {
  const [invitation, setInvitation] = useState(""),
    [name, setName] = useState("");
  return (
    <div className="space-y-4">
      <p>
        Send this device request to a workspace admin. They can approve it in
        Devices and return an invitation. Keep their workspace online while
        joining.
      </p>
      <DeviceRequestInput value={request} />
      <label className="block space-y-2">
        Save name
        <Input
          aria-label="Save name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="block space-y-2">
        Workspace invitation
        <Textarea
          aria-label="Workspace invitation"
          value={invitation}
          onChange={(event) => setInvitation(event.target.value)}
        />
      </label>
      <Button
        disabled={disabled || !invitation.trim()}
        onClick={() => void onJoin(invitation, { kind: "internal", name })}
      >
        Join workspace
      </Button>
    </div>
  );
}
