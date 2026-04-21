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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface ResultViewerDialogsProps {
  dirtyNavDialogOpen: boolean;
  quitDialogOpen: boolean;
  resetDialogOpen: boolean;
  onDirtyNavOpenChange: (open: boolean) => void;
  onQuitDialogOpenChange: (open: boolean) => void;
  onResetDialogOpenChange: (open: boolean) => void;
  onKeepEditing: () => void;
  onDiscardEdits: () => void;
  onQuitWithoutSaving: () => void;
  onSaveAndQuit: () => void;
  onCancelReset: () => void;
  onConfirmReset: () => void;
  saveAndQuitDisabled: boolean;
}

export function ResultViewerDialogs({
  dirtyNavDialogOpen,
  quitDialogOpen,
  resetDialogOpen,
  onDirtyNavOpenChange,
  onQuitDialogOpenChange,
  onResetDialogOpenChange,
  onKeepEditing,
  onDiscardEdits,
  onQuitWithoutSaving,
  onSaveAndQuit,
  onCancelReset,
  onConfirmReset,
  saveAndQuitDisabled,
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

      <Dialog open={quitDialogOpen} onOpenChange={onQuitDialogOpenChange}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Save before quitting?</DialogTitle>
            <DialogDescription>
              Leave the results viewer now, or save your latest annotation edits before you quit.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={onQuitWithoutSaving}>
              Quit
            </Button>
            <Button onClick={onSaveAndQuit} disabled={saveAndQuitDisabled}>
              Save &amp; Quit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
