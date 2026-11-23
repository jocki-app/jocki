import type { ReactNode } from "react";
import { Save, Trash2, X } from "lucide-react";
import { Button } from "./primitives/button";

/** Stable action slots: sync/save followed by delete/discard. */
export function EditActions({
  dirty,
  disabled,
  idlePrimary,
  onSave,
  onCancel,
  onDelete,
  deleteDisabled,
  saveDisabled,
  labels,
}: {
  dirty: boolean;
  disabled?: boolean;
  idlePrimary?: ReactNode;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  deleteDisabled?: boolean;
  saveDisabled?: boolean;
  labels: { save: string; cancel: string; delete: string };
}) {
  return (
    <>
      {dirty ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={labels.save}
          disabled={disabled || saveDisabled}
          onClick={onSave}
        >
          <Save />
        </Button>
      ) : (
        idlePrimary
      )}
      {dirty ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={labels.cancel}
          disabled={disabled}
          onClick={onCancel}
        >
          <X />
        </Button>
      ) : (
        onDelete && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={labels.delete}
            disabled={disabled || deleteDisabled}
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        )
      )}
    </>
  );
}
