import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Clock,
  FlaskConical,
  Images,
  Microscope,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";

import { AnimatedNumber } from "@/components/common/AnimatedNumber";
import { ErrorState } from "@/components/common/ErrorState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { getDashboardStats } from "@/services/api";
import type { AnalysisBatchSummary, DashboardStats } from "@/types/api";

const chartConfig = {
  images: {
    label: "Images",
    color: "var(--chart-1)",
  },
  detections: {
    label: "Detections",
    color: "var(--chart-2)",
  },
  confidence: {
    label: "Confidence",
    color: "var(--chart-3)",
  },
} satisfies ChartConfig;

function formatCompact(value: number | null | undefined) {
  if (value == null) return "0";
  return Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
}

function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDay(isoString: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(isoString));
}

function buildActivityData(recent: AnalysisBatchSummary[]) {
  return [...recent]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(-8)
    .map((batch) => ({
      label: formatDay(batch.created_at),
      images: batch.total_image_count,
      detections: batch.total_count ?? 0,
      confidence: batch.avg_confidence != null ? Math.round(batch.avg_confidence * 100) : 0,
    }));
}

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        status === "completed" && "bg-green-500",
        status === "processing" && "bg-yellow-500",
        status === "failed" && "bg-red-500",
        !["completed", "processing", "failed"].includes(status) && "bg-muted-foreground",
      )}
    />
  );
}

interface KpiCardProps {
  label: string;
  value: number | null | undefined;
  decimals?: number;
  suffix?: string;
  detail: string;
  icon: React.ElementType;
  loading: boolean;
}

function KpiCard({
  label,
  value,
  decimals = 0,
  suffix,
  detail,
  icon: Icon,
  loading,
}: KpiCardProps) {
  return (
    <Card className="border-0 bg-card/70 shadow-sm">
      <CardContent className="flex items-center gap-4 px-4 py-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-muted-foreground">
            {label}
          </p>
          {loading ? (
            <Skeleton className="mt-2 h-7 w-20" />
          ) : (
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {value != null ? (
                <AnimatedNumber value={value} decimals={decimals} />
              ) : (
                "0"
              )}
              {suffix && <span className="text-base text-muted-foreground">{suffix}</span>}
            </div>
          )}
          <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>
        </div>
      </CardContent>
    </Card>
  );
}

interface RecentItemProps {
  batch: AnalysisBatchSummary;
  onClick: (batchId: string) => void;
}

function RecentItem({ batch, onClick }: RecentItemProps) {
  return (
    <button
      type="button"
      onClick={() => onClick(batch.id)}
      className="group flex w-full items-center gap-3 rounded-md bg-muted/40 px-3 py-2.5 text-left transition-colors duration-100 hover:bg-muted focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <StatusDot status={batch.status} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {batch.name || `${batch.organism_type} ${batch.mode}`}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {batch.total_image_count} image{batch.total_image_count !== 1 ? "s" : ""}
          {batch.total_count !== null && ` · ${batch.total_count} detections`}
          {batch.avg_confidence !== null && ` · ${(batch.avg_confidence * 100).toFixed(0)}% avg`}
        </div>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {timeAgo(batch.created_at)}
      </span>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-all duration-150 group-hover:translate-x-0.5 group-hover:opacity-100" />
    </button>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const activityData = useMemo(
    () => buildActivityData(stats?.recent_analyses ?? []),
    [stats?.recent_analyses],
  );

  const bestRecent = useMemo(() => {
    const recent = stats?.recent_analyses ?? [];
    return recent.reduce<AnalysisBatchSummary | null>((best, batch) => {
      if (!best) return batch;
      return (batch.total_count ?? 0) > (best.total_count ?? 0) ? batch : best;
    }, null);
  }, [stats?.recent_analyses]);

  const handleRecentClick = useCallback(
    (id: string) => navigate(`/recorded?batch=${id}`),
    [navigate],
  );

  const fetchStats = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    getDashboardStats(signal)
      .then((data) => {
        if (!signal?.aborted) setStats(data);
      })
      .catch((err) => {
        if (signal?.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(String(err));
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false);
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchStats(controller.signal);
    return () => controller.abort();
  }, [fetchStats]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label="Analyses"
            value={stats?.total_analyses}
            detail={`${formatCompact(stats?.total_images_processed)} images processed`}
            icon={Microscope}
            loading={loading}
          />
          <KpiCard
            label="Detections"
            value={stats?.total_eggs_counted}
            detail="Total objects counted"
            icon={CheckCircle2}
            loading={loading}
          />
          <KpiCard
            label="Confidence"
            value={stats?.avg_confidence != null ? stats.avg_confidence * 100 : null}
            decimals={1}
            suffix="%"
            detail="Average model confidence"
            icon={TrendingUp}
            loading={loading}
          />
          <KpiCard
            label="Speed"
            value={stats?.avg_processing_time}
            decimals={1}
            suffix="s"
            detail="Average per image"
            icon={Clock}
            loading={loading}
          />
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.85fr)]">
          <Card className="border-0 bg-card/70 shadow-sm">
            <CardHeader className="gap-0 pb-2">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Activity className="size-4 text-primary" />
                    Analysis activity
                  </CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Recent image volume and detection counts from saved batches.
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => navigate("/recorded")}>
                  Recorded
                  <ArrowRight className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              {loading ? (
                <Skeleton className="h-[310px] w-full rounded-lg" />
              ) : error ? (
                <ErrorState
                  message={error}
                  title="Failed to load dashboard"
                  onRetry={() => fetchStats()}
                />
              ) : activityData.length > 0 ? (
                <ChartContainer config={chartConfig} className="h-[310px] w-full">
                  <BarChart accessibilityLayer data={activityData}>
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="label"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={10}
                    />
                    <YAxis hide />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar
                      dataKey="images"
                      fill="var(--color-images)"
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      dataKey="detections"
                      fill="var(--color-detections)"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ChartContainer>
              ) : (
                <div className="flex h-[310px] flex-col items-center justify-center rounded-lg bg-muted/40 text-center">
                  <Sparkles className="mb-3 size-8 text-primary" />
                  <p className="text-sm font-medium">No activity yet</p>
                  <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                    Run an analysis and this panel will become a live dashboard.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-6">
            <Card className="border-0 bg-primary text-primary-foreground shadow-sm">
              <CardContent className="px-5 py-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium opacity-80">Next run</p>
                    <h2 className="mt-2 text-2xl font-semibold tracking-tight">
                      Start a fresh analysis
                    </h2>
                    <p className="mt-2 text-sm opacity-80">
                      Upload a batch, choose the organism, and let the detector do the counting.
                    </p>
                  </div>
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary-foreground/15">
                    <FlaskConical className="size-5" />
                  </div>
                </div>
                <Button
                  className="mt-5 w-full bg-primary-foreground text-primary hover:bg-primary-foreground/90"
                  onClick={() => navigate("/analyze")}
                >
                  Start Analysis
                  <ArrowRight className="size-4" />
                </Button>
              </CardContent>
            </Card>

            <Card className="border-0 bg-card/70 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Images className="size-4 text-primary" />
                  Recent activity
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {loading ? (
                  <>
                    <Skeleton className="h-12 w-full rounded-md" />
                    <Skeleton className="h-12 w-full rounded-md" />
                    <Skeleton className="h-12 w-full rounded-md" />
                  </>
                ) : error ? (
                  <p className="text-sm text-muted-foreground">
                    Recent activity is unavailable.
                  </p>
                ) : stats?.recent_analyses.length === 0 ? (
                  <p className="rounded-md bg-muted/40 px-3 py-8 text-center text-sm text-muted-foreground">
                    No analyses yet.
                  </p>
                ) : (
                  stats?.recent_analyses.slice(0, 5).map((batch) => (
                    <RecentItem
                      key={batch.id}
                      batch={batch}
                      onClick={handleRecentClick}
                    />
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <Card className="border-0 bg-card/70 shadow-sm lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Confidence pulse</CardTitle>
              <p className="text-sm text-muted-foreground">
                Average confidence across the latest saved batches.
              </p>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-[180px] w-full rounded-lg" />
              ) : activityData.length > 0 ? (
                <ChartContainer config={chartConfig} className="h-[180px] w-full">
                  <AreaChart accessibilityLayer data={activityData}>
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="label"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={10}
                    />
                    <YAxis hide domain={[0, 100]} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Area
                      dataKey="confidence"
                      type="monotone"
                      fill="var(--color-confidence)"
                      fillOpacity={0.18}
                      stroke="var(--color-confidence)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ChartContainer>
              ) : (
                <div className="flex h-[180px] items-center justify-center rounded-lg bg-muted/40 text-sm text-muted-foreground">
                  Confidence trend appears after completed analyses.
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-0 bg-card/70 shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Top recent batch</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="space-y-3">
                  <Skeleton className="h-7 w-3/4" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : bestRecent ? (
                <div className="space-y-4">
                  <div>
                    <p className="truncate text-lg font-semibold">
                      {bestRecent.name || bestRecent.organism_type}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {bestRecent.total_image_count} images · {timeAgo(bestRecent.created_at)}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-md bg-muted/40 p-3">
                      <p className="text-xs text-muted-foreground">Detections</p>
                      <p className="mt-1 text-xl font-semibold tabular-nums">
                        {formatCompact(bestRecent.total_count)}
                      </p>
                    </div>
                    <div className="rounded-md bg-muted/40 p-3">
                      <p className="text-xs text-muted-foreground">Confidence</p>
                      <p className="mt-1 text-xl font-semibold tabular-nums">
                        {bestRecent.avg_confidence != null
                          ? `${Math.round(bestRecent.avg_confidence * 100)}%`
                          : "0%"}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => handleRecentClick(bestRecent.id)}
                  >
                    Open batch
                    <ArrowRight className="size-4" />
                  </Button>
                </div>
              ) : (
                <div className="rounded-md bg-muted/40 px-3 py-8 text-center text-sm text-muted-foreground">
                  Run a batch to highlight your strongest recent result.
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
