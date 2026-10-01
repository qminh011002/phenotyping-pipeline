// Keyboard-shortcut reference for the result viewer (press ? to open).

import { Fragment } from 'react';

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

interface ShortcutsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Polygon editor (larvae / pupae) vs box editor (egg / neonate). */
    polygon: boolean;
}

type Row = [keys: string[], action: string];

const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
const MOD = isMac ? '⌘' : 'Ctrl';

const COMMON_TOOLS: Row[] = [
    [['V'], 'Select tool'],
    [['E'], 'Erase tool — click a detection to delete it'],
    [['Del'], 'Delete the selected detection'],
    [['Esc'], 'Cancel the current action / deselect'],
];

const VIEW: Row[] = [
    [['Scroll'], 'Zoom at the cursor'],
    [['+'], 'Zoom in'],
    [['−'], 'Zoom out'],
    [['0'], 'Fit image to the window'],
    [['Space', 'drag'], 'Pan from any tool'],
    [[`Hold ${MOD}`], 'Hide detections to see the image'],
];

const NAVIGATE: Row[] = [
    [['←'], 'Previous image'],
    [['→'], 'Next image'],
    [['?'], 'Show this reference'],
];

const HISTORY: Row[] = [
    [[MOD, 'Z'], 'Undo'],
    [[MOD, '⇧', 'Z'], 'Redo'],
    [[MOD, 'S'], 'Save now (edits also save automatically)'],
];

const BOX_TOOLS: Row[] = [[['D'], 'Draw a new box (drag)'], ...COMMON_TOOLS];

const POLYGON_TOOLS: Row[] = [
    [['D'], 'Draw a new outline (click to place points)'],
    [['Enter'], 'Finish the outline being drawn'],
    [['Bksp'], 'Remove the last point while drawing'],
    ...COMMON_TOOLS,
];

function Group({ title, rows }: { title: string; rows: Row[] }) {
    return (
        <section>
            <h3 className="eyebrow mb-2">{title}</h3>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
                {rows.map(([keys, action]) => (
                    <Fragment key={action}>
                        <dt className="flex items-center gap-1">
                            {keys.map((k) => (
                                <kbd key={k} className="kbd">
                                    {k}
                                </kbd>
                            ))}
                        </dt>
                        <dd className="text-muted-foreground">{action}</dd>
                    </Fragment>
                ))}
            </dl>
        </section>
    );
}

export function ShortcutsDialog({ open, onOpenChange, polygon }: ShortcutsDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="lg">
                <DialogHeader>
                    <DialogTitle>Keyboard shortcuts</DialogTitle>
                    <DialogDescription>
                        Everything in the editor can be done without leaving the keyboard.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
                    <Group title="Tools" rows={polygon ? POLYGON_TOOLS : BOX_TOOLS} />
                    <Group title="View" rows={VIEW} />
                    <Group title="History" rows={HISTORY} />
                    <Group title="Navigate" rows={NAVIGATE} />
                </div>
            </DialogContent>
        </Dialog>
    );
}
