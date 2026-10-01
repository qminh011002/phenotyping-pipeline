// ModelUploadDialog — pick a YOLO `.pt` file and upload it to one organism's
// model library, with progress, success and error feedback.

import { useState, useCallback, useId, useRef } from 'react';
import { CheckCircle2, Upload, XCircle } from 'lucide-react';

import { OrganismBadge } from '@/components/common';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { toast } from '@/components/ui/sonner';
import { formatBytes } from '@/lib/format';
import { organismMeta } from '@/lib/organism';
import { uploadCustomModel } from '@/services/api';
import { ApiError } from '@/services/errors';
import type { Organism } from '@/types/api';

interface ModelUploadDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    organism: Organism | null;
    onSuccess: () => void;
}

type UploadState = 'idle' | 'uploading' | 'success' | 'error';

export function ModelUploadDialog({
    open,
    onOpenChange,
    organism,
    onSuccess,
}: ModelUploadDialogProps) {
    const [file, setFile] = useState<File | null>(null);
    const [state, setState] = useState<UploadState>('idle');
    const [progress, setProgress] = useState(0);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const inputId = useId();

    const slotLabel = organism ? organismMeta(organism).label : 'Selected';

    const reset = useCallback(() => {
        setFile(null);
        setState('idle');
        setProgress(0);
        setErrorMsg(null);
    }, []);

    const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const selected = e.target.files?.[0];
        if (!selected) return;
        if (!selected.name.toLowerCase().endsWith('.pt')) {
            toast.error('Only .pt files are accepted');
            return;
        }
        setFile(selected);
        setErrorMsg(null);
        setState('idle');
    }, []);

    const handleUpload = useCallback(async () => {
        if (!file || !organism) return;

        setState('uploading');
        setProgress(20);
        setErrorMsg(null);

        try {
            setProgress(50);
            await uploadCustomModel(organism, file);
            setProgress(100);

            setState('success');
            toast.success('Model uploaded', {
                description: `${file.name} is ready for ${slotLabel}.`,
            });
            onSuccess();
        } catch (err) {
            setState('error');
            const msg = err instanceof ApiError ? (err.message ?? 'Upload failed') : String(err);
            setErrorMsg(msg);
            toast.error('Model upload failed', { description: msg });
        }
    }, [file, onSuccess, organism, slotLabel]);

    const handleClose = useCallback(
        (open: boolean) => {
            if (!open) reset();
            onOpenChange(open);
        },
        [onOpenChange, reset],
    );

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex flex-wrap items-center gap-2">
                        Upload {slotLabel.toLowerCase()} model
                        {organism && <OrganismBadge organism={organism} />}
                    </DialogTitle>
                    <DialogDescription>
                        Upload a YOLO detection model (<code className="font-mono">.pt</code>) for
                        the {slotLabel.toLowerCase()} mode. After uploading, you can activate it
                        from that mode's model list.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    {/* File picker */}
                    <div className="space-y-2">
                        <Label htmlFor={inputId}>Model file (.pt)</Label>
                        <Button
                            variant="outline"
                            className="w-full justify-start font-mono"
                            onClick={() => inputRef.current?.click()}
                            disabled={state === 'uploading'}
                        >
                            <Upload className="size-4 shrink-0" aria-hidden />
                            <span className="min-w-0 truncate">
                                {file ? file.name : 'Choose .pt file…'}
                            </span>
                        </Button>
                        <input
                            id={inputId}
                            ref={inputRef}
                            type="file"
                            accept=".pt"
                            onChange={handleFileChange}
                            className="hidden"
                        />
                        {file && (
                            <p className="text-xs text-muted-foreground tabular-nums">
                                {formatBytes(file.size)}
                            </p>
                        )}
                    </div>

                    {/* Progress */}
                    {state === 'uploading' && (
                        <div className="space-y-2" role="status">
                            <Progress value={progress} className="h-1.5" />
                            <p className="text-xs text-muted-foreground">
                                Uploading and validating model…
                            </p>
                        </div>
                    )}

                    {/* Success */}
                    {state === 'success' && (
                        <div
                            role="status"
                            className="flex items-start gap-2 rounded-md border border-success/25 bg-success/10 px-3 py-2 text-sm text-success"
                        >
                            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
                            <span>
                                Model uploaded successfully. Activate it for{' '}
                                {slotLabel.toLowerCase()} when ready.
                            </span>
                        </div>
                    )}

                    {/* Error */}
                    {state === 'error' && errorMsg && (
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                        >
                            <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                            <span className="min-w-0 break-words">{errorMsg}</span>
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex justify-end gap-2 pt-2">
                        <Button
                            variant="ghost"
                            onClick={() => handleClose(false)}
                            disabled={state === 'uploading'}
                        >
                            {state === 'success' ? 'Close' : 'Cancel'}
                        </Button>
                        {state !== 'success' && (
                            <Button
                                onClick={handleUpload}
                                disabled={!file || !organism || state === 'uploading'}
                            >
                                <Upload className="size-4" aria-hidden />
                                {state === 'uploading' ? 'Uploading…' : 'Upload'}
                            </Button>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
