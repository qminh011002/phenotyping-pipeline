import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ResultViewerDialogsProps {
  dirtyNavDialogOpen: boolean;
  resetDialogOpen: boolean;
  onDirtyNavOpenChange: (open: boolean) => void;
  onResetDialogOpenChange: (open: boolean) => void;
  onKeepEditing: () => void;
  onDiscardEdits: () => void;
  onCancelReset: () => void;
  onConfirmReset: () => void;
}

export function ResultViewerDialogs({
  dirtyNavDialogOpen,
  resetDialogOpen,
  onDirtyNavOpenChange,
  onResetDialogOpenChange,
  onKeepEditing,
  onDiscardEdits,
  onCancelReset,
  onConfirmReset,
}: ResultViewerDialogsProps) {
  return (
    <>
      <AlertDialog
        open={dirtyNavDialogOpen}
        onOpenChange={onDirtyNavOpenChange}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved edits?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved annotation edits. Navigating away will discard
              them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onKeepEditing}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction onClick={onDiscardEdits}>
              Discard edits
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={resetDialogOpen}
        onOpenChange={onResetDialogOpenChange}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to model output?</AlertDialogTitle>
            <AlertDialogDescription>
              This will discard all annotation edits and restore the original
              model detections. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelReset}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onConfirmReset}
            >
              Reset to model
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
