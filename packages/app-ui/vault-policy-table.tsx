import { RefreshCw, History, Share2, X } from "lucide-react";
import type { FileVault } from "../core/vaults/vault";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../ui/primitives/table";
import { Button } from "../ui/primitives/button";
export function VaultPolicyTable({
  vaults,
  onHistory,
  onSharing,
  onOpen,
  onRescan,
  onRecover,
  onClose,
}: {
  vaults: FileVault[];
  onHistory(vault: FileVault): void;
  onSharing(vault: FileVault): void;
  onOpen(vault: FileVault): void;
  onRescan(vault: FileVault): void;
  onRecover(vault: FileVault): void;
  onClose(vault: FileVault): void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Vault</TableHead>
          <TableHead className="hidden sm:table-cell">Files</TableHead>
          <TableHead>History</TableHead>
          <TableHead>Sharing</TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {vaults.map((v) => (
          <TableRow key={v.id}>
            <TableCell>
              <Button
                variant="link"
                className="max-w-48 truncate px-0"
                onClick={() => onOpen(v)}
              >
                {v.name}
              </Button>
            </TableCell>
            <TableCell className="hidden sm:table-cell">
              {v.list().length}
            </TableCell>
            <TableCell>
              <Button variant="outline" onClick={() => onHistory(v)}>
                <History />
                {v.policy.history ? "History" : "Enable history"}
              </Button>
            </TableCell>
            <TableCell>
              <Button variant="outline" onClick={() => onSharing(v)}>
                <Share2 />
                {v.policy.sync ? "Sharing" : "Enable sharing"}
              </Button>
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Rescan ${v.name}`}
                  onClick={() => onRescan(v)}
                >
                  <RefreshCw />
                </Button>
                {v.policy.history && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Recover deleted files in ${v.name}`}
                    onClick={() => onRecover(v)}
                  >
                    <History />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Close ${v.name}`}
                  onClick={() => onClose(v)}
                >
                  <X />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
