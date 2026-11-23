import { History, Share2 } from "lucide-react";
import type { Features } from "../core/vaults/scope-policy";
import { Button } from "../ui/primitives/button";

export function VaultFeatureButtons({
  features,
  onHistory,
  onSharing,
}: {
  features: Features;
  onHistory(): void;
  onSharing(): void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={onHistory}>
        <History />
        {features.history ? "History" : "Enable history"}
      </Button>
      <Button variant="outline" onClick={onSharing}>
        <Share2 />
        {features.sync ? "Sharing" : "Enable sharing"}
      </Button>
    </div>
  );
}
