import { useQuery } from '@tanstack/react-query';
import { Cpu, RefreshCw, Zap } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { getHealth } from '@/services/api';

const ORGANISM_LABEL: Record<string, string> = {
    egg: 'Egg',
    larvae: 'Larvae',
    pupae: 'Pupae',
    neonate: 'Neonate',
};

function deviceVariant(device: string): 'default' | 'secondary' | 'destructive' {
    if (device.startsWith('cuda')) return 'default';
    if (device === 'cpu') return 'secondary';
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
        <section className="space-y-4">
            <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                    <h2 className="flex items-center gap-2 text-base font-semibold">
                        <Cpu className="h-4 w-4" />
                        Compute Device
                    </h2>
                    <p className="text-sm text-muted-foreground">
                        Cho biết app có thể nhận diện GPU hay không. Inference sẽ tự động
                        fallback về CPU khi không có CUDA.
                    </p>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => healthQuery.refetch()}
                    disabled={healthQuery.isFetching}
                >
                    <RefreshCw
                        className={`h-3.5 w-3.5 ${healthQuery.isFetching ? 'animate-spin' : ''}`}
                    />
                    Refresh
                </Button>
            </div>

            <section className="rounded-md bg-card/55 p-5 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]">
                {loading ? (
                    <div className="space-y-3">
                        <Skeleton className="h-6 w-48" />
                        <Skeleton className="h-20 w-full" />
                    </div>
                ) : error ? (
                    <p className="text-sm text-destructive">{error}</p>
                ) : (
                    <div className="space-y-5">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex items-center gap-3">
                                <div
                                    className={`flex size-11 items-center justify-center rounded-md ${
                                        cudaAvailable
                                            ? 'bg-primary/15 text-primary'
                                            : 'bg-muted/45 text-muted-foreground'
                                    }`}
                                >
                                    <Zap className="h-5 w-5" />
                                </div>
                                <div>
                                    <p className="text-sm font-semibold">
                                        {cudaAvailable ? 'GPU detected' : 'No GPU available'}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        {cudaAvailable
                                            ? `Inference can run on CUDA (${cudaCount} device${cudaCount !== 1 ? 's' : ''}).`
                                            : 'Inference will run on CPU. Install a CUDA-capable GPU + drivers to enable GPU acceleration.'}
                                    </p>
                                </div>
                            </div>
                            <Badge variant={cudaAvailable ? 'default' : 'secondary'}>
                                {cudaAvailable ? 'CUDA available' : 'CPU only'}
                            </Badge>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-3">
                            <div className="rounded-md bg-muted/35 px-3 py-2">
                                <p className="text-xs text-muted-foreground">CUDA available</p>
                                <p className="mt-1 text-base font-semibold">
                                    {cudaAvailable ? 'Yes' : 'No'}
                                </p>
                            </div>
                            <div className="rounded-md bg-muted/35 px-3 py-2">
                                <p className="text-xs text-muted-foreground">Device count</p>
                                <p className="mt-1 text-base font-semibold tabular-nums">
                                    {cudaCount}
                                </p>
                            </div>
                            <div className="rounded-md bg-muted/35 px-3 py-2">
                                <p className="text-xs text-muted-foreground">Primary device</p>
                                <p
                                    className="mt-1 truncate text-base font-semibold"
                                    title={cudaName ?? 'CPU'}
                                >
                                    {cudaName ?? 'CPU'}
                                </p>
                            </div>
                        </div>

                        <div>
                            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                                Active device per organism
                            </p>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                                {Object.keys(ORGANISM_LABEL).map((organism) => {
                                    const device = devicesPerOrganism[organism as keyof typeof devicesPerOrganism];
                                    return (
                                        <div
                                            key={organism}
                                            className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2"
                                        >
                                            <span className="text-sm">{ORGANISM_LABEL[organism]}</span>
                                            {device ? (
                                                <Badge variant={deviceVariant(device)}>{device}</Badge>
                                            ) : (
                                                <Badge variant="outline">unloaded</Badge>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </section>
        </section>
    );
}
