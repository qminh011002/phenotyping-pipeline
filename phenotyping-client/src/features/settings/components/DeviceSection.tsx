// DeviceSection — whether the backend sees a GPU, and which device each
// organism's model is running on. Polls /health every 30 seconds.

import { useQuery } from '@tanstack/react-query';
import { AlertCircle, RefreshCw, Zap } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { pluralize } from '@/lib/format';
import { ORGANISM_ORDER } from '@/lib/organism';
import { cn } from '@/lib/utils';
import { getHealth } from '@/services/api';
import { Chip, OrganismLabel, SettingsSection } from './SettingsSection';

function deviceTone(device: string): 'success' | 'neutral' | 'destructive' {
    if (device.startsWith('cuda')) return 'success';
    if (device === 'cpu') return 'neutral';
    return 'destructive';
}

export function DeviceSection() {
    const healthQuery = useQuery({
        queryKey: ['health-device'],
        queryFn: ({ signal }) => getHealth(signal),
        refetchInterval: 30_000,
    });

    const data = healthQuery.data;
    const loading = healthQuery.isPending;
    const error = healthQuery.error ? String(healthQuery.error) : null;
    const cudaAvailable = data?.cuda_available ?? false;
    const cudaCount = data?.cuda_device_count ?? 0;
    const cudaName = data?.cuda_device_name ?? null;
    const devicesPerOrganism = data?.devices_per_organism ?? {};

    return (
        <SettingsSection
            title="Compute device"
            description="Shows whether the app can detect a GPU. Inference automatically falls back to CPU when CUDA is unavailable."
            actions={
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => healthQuery.refetch()}
                    disabled={healthQuery.isFetching}
                >
                    <RefreshCw
                        className={cn('size-3.5', healthQuery.isFetching && 'animate-spin')}
                        aria-hidden
                    />
                    Refresh
                </Button>
            }
        >
            {loading ? (
                <div className="space-y-4">
                    <Skeleton className="h-9 w-56" />
                    <Skeleton className="h-14 w-full" />
                    <Skeleton className="h-36 w-full" />
                </div>
            ) : error ? (
                <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span className="min-w-0 break-words">{error}</span>
                </p>
            ) : (
                <div className="space-y-5">
                    <div className="flex items-start gap-3">
                        <div
                            className={cn(
                                'flex size-9 shrink-0 items-center justify-center rounded-md border',
                                cudaAvailable
                                    ? 'border-success/25 bg-success/10 text-success'
                                    : 'border-border bg-muted text-muted-foreground',
                            )}
                        >
                            <Zap className="size-4" aria-hidden />
                        </div>
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <p className="text-sm font-semibold">
                                    {cudaAvailable ? 'GPU detected' : 'No GPU available'}
                                </p>
                                <Chip tone={cudaAvailable ? 'success' : 'neutral'}>
                                    {cudaAvailable ? 'CUDA available' : 'CPU only'}
                                </Chip>
                            </div>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                                {cudaAvailable
                                    ? `Inference can run on CUDA (${cudaCount} ${pluralize(cudaCount, 'device')}).`
                                    : 'Inference will run on CPU. Install a CUDA-capable GPU and drivers to enable GPU acceleration.'}
                            </p>
                        </div>
                    </div>

                    <dl className="grid divide-y divide-border overflow-hidden rounded-lg border border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                        <div className="min-w-0 px-3 py-2.5">
                            <dt className="text-xs text-muted-foreground">CUDA available</dt>
                            <dd className="mt-0.5 text-sm font-semibold">
                                {cudaAvailable ? 'Yes' : 'No'}
                            </dd>
                        </div>
                        <div className="min-w-0 px-3 py-2.5">
                            <dt className="text-xs text-muted-foreground">Device count</dt>
                            <dd className="mt-0.5 text-sm font-semibold tabular-nums">
                                {cudaCount}
                            </dd>
                        </div>
                        <div className="min-w-0 px-3 py-2.5">
                            <dt className="text-xs text-muted-foreground">Primary device</dt>
                            <dd
                                className="mt-0.5 truncate text-sm font-semibold"
                                title={cudaName ?? 'CPU'}
                            >
                                {cudaName ?? 'CPU'}
                            </dd>
                        </div>
                    </dl>

                    <div>
                        <p className="eyebrow">Active device per organism</p>
                        <ul className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
                            {ORGANISM_ORDER.map((organism) => {
                                const device = devicesPerOrganism[organism];
                                return (
                                    <li
                                        key={organism}
                                        className="flex items-center justify-between gap-3 px-3 py-2"
                                    >
                                        <OrganismLabel organism={organism} className="text-sm" />
                                        {device ? (
                                            <Chip tone={deviceTone(device)} className="font-mono">
                                                {device}
                                            </Chip>
                                        ) : (
                                            <Chip
                                                tone="outline"
                                                className="border-dashed text-muted-foreground"
                                                title="No model is loaded for this organism"
                                            >
                                                Not loaded
                                            </Chip>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                </div>
            )}
        </SettingsSection>
    );
}
