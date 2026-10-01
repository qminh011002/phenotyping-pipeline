// ModelSlotCard — one organism's model slot at a glance: which weight file is
// active (default or custom), with Replace and Revert actions.

import { RefreshCw, Upload } from 'lucide-react';

import { OrganismBadge } from '@/components/common';
import { Button } from '@/components/ui/button';
import { formatBytes, formatDateTime } from '@/lib/format';
import type { OrganismAssignment, Organism } from '@/types/api';
import { Chip } from './SettingsSection';

interface ModelSlotCardProps {
    assignment: OrganismAssignment;
    onReplace: (organism: Organism) => void;
    onRevert: (organism: Organism) => void;
    reverting?: boolean;
}

export function ModelSlotCard({ assignment, onReplace, onRevert, reverting }: ModelSlotCardProps) {
    const { organism, is_default, has_default, model_filename, custom_model } = assignment;
    const slotMissing = custom_model === null && !has_default;

    return (
        <div className="panel flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                    <OrganismBadge organism={organism} />
                    {slotMissing ? (
                        <Chip tone="destructive">Not installed</Chip>
                    ) : (
                        <Chip tone={is_default ? 'neutral' : 'primary'}>
                            {is_default ? 'Default' : 'Custom'}
                        </Chip>
                    )}
                </div>

                <p
                    className="truncate font-mono text-sm text-muted-foreground"
                    title={model_filename ?? undefined}
                >
                    {model_filename ?? '—'}
                </p>

                {custom_model && (
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span className="tabular-nums">
                            {formatBytes(custom_model.file_size_bytes)}
                        </span>
                        <span>{formatDateTime(custom_model.uploaded_at)}</span>
                    </div>
                )}
            </div>

            <div className="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" onClick={() => onReplace(organism)}>
                    <Upload className="size-3.5" aria-hidden />
                    Replace
                </Button>
                {!is_default && (
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onRevert(organism)}
                        disabled={reverting}
                    >
                        <RefreshCw className="size-3.5" aria-hidden />
                        {reverting ? 'Reverting…' : 'Revert'}
                    </Button>
                )}
            </div>
        </div>
    );
}
