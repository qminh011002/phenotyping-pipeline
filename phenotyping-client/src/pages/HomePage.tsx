// Home page — dashboard with metric cards, quick-entry CTA, and recent analyses.
//
// The wireframe from ui-ux-design.mdc:
//
//   ┌──────────────────────────────────────────────────┐
//   │ [metric] [metric] [metric] [metric] │
//   │ │
//   │ ┌─────────────────┐ ┌────────────────────────┐ │
//   │ │ │ │ Recent Analyses │ │
//   │ │ Start New │ │ ┌──────────────────┐ │ │
//   │ │ Analysis │ │ │ IMG_001 · 142 eggs│ │ │
//   │ │ [large button] │ │ │ 2 min ago │ │ │
//   │ │ │ │ └──────────────────┘ │ │
//   │ └─────────────────┘ │ ┌──────────────────┐ │ │
//   │ │ │ IMG_002 · 89 eggs │ │ │
//   │ │ │ 15 min ago │ │ │
//   │ │ └──────────────────┘ │ │
//   │ ���────────────────────────┘ │
//   └──────────────────────────────────────────────────┘
//

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FlaskConical, Microscope, Clock, CheckCircle2, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/common/ErrorState";
import { AnimatedNumber } from "@/components/common/AnimatedNumber";
import { cn } from "@/lib/utils";
import { getDashboardStats } from "@/services/api";
import type { AnalysisBatchSummary, DashboardStats } from "@/types/api";

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

interface MetricCardProps {
  label: string;
  value: number | null | undefined;
  decimals?: number;
  subtitle?: string;
  icon: React.ElementType;
  loading?: boolean;
  suffix?: string;
}

function MetricCard({ label, value, decimals = 0, subtitle, icon: Icon, loading, suffix }: MetricCardProps) {
  if (loading) {
    return (
      <Card className="transition-colors duration-150 hover:bg-accent/30">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-4" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-16" />
          <Skeleton className="mt-1 h-3 w-28" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="transition-colors duration-150 hover:bg-accent/30">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">
          {value !== null && value !== undefined
            ? <AnimatedNumber value={value} decimals={decimals} />
            : "—"}
          {suffix && <span className="text-lg">{suffix}</span>}
        </div>
        {subtitle && (
          <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
        )}
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
    <div
      role="button"
      tabIndex={0}
      onClick={() => onClick(batch.id)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(batch.id); } }}
      className="group flex items-center gap-4 rounded-md border px-3 py-2 transition-colors duration-100 hover:bg-accent/50 focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 cursor-pointer active:scale-[0.99]"
    >
      <StatusDot status={batch.status} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {batch.organism_type} · {batch.mode}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {batch.total_image_count} image{batch.total_image_count !== 1 ? "s" : ""}
          {batch.total_count !== null && ` · ${batch.total_count} eggs`}
          {batch.avg_confidence !== null && ` · avg ${(batch.avg_confidence * 100).toFixed(0)}%`}
        </div>
      </div>
      <div className="shrink-0 text-xs text-muted-foreground">
        {timeAgo(batch.created_at)}
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-all duration-150 group-hover:translate-x-0.5 group-hover:text-foreground group-hover:opacity-100 opacity-0 -translate-x-1" />
    </div>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function fetchStats() {
    setLoading(true);
    setError(null);
    getDashboardStats()
      .then((data) => setStats(data))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    fetchStats();
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <header className="flex items-center justify-between border-b px-6 py-4">
        <h1 className="text-lg font-semibold">Dashboard</h1>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {/* Metric cards row */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 mb-6">
          <MetricCard
            label="Total Analyses"
            value={loading ? undefined : (stats?.total_analyses ?? null)}
            subtitle={loading ? "" : `${stats?.total_images_processed} images processed`}
            icon={Microscope}
            loading={loading}
          />
          <MetricCard
            label="Total Eggs Counted"
            value={loading ? undefined : (stats?.total_eggs_counted ?? null)}
            subtitle={loading ? "" : `${stats?.total_images_processed} images`}
            icon={CheckCircle2}
            loading={loading}
          />
          <MetricCard
            label="Avg Confidence"
            value={loading ? undefined : (stats?.avg_confidence != null ? stats.avg_confidence * 100 : null)}
            decimals={1}
            suffix="%"
            subtitle={loading ? "" : "Across all images"}
            icon={FlaskConical}
            loading={loading}
          />
          <MetricCard
            label="Avg Processing Time"
            value={loading ? undefined : (stats?.avg_processing_time ?? null)}
            decimals={1}
            suffix="s"
            subtitle={loading ? "" : "Per image"}
            icon={Clock}
            loading={loading}
          />
        </div>

        {/* Bottom section: CTA + recent analyses */}
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Start Analysis CTA */}
          <Card className="flex flex-col items-center justify-center py-10 lg:col-span-1">
            <CardContent className="flex flex-col items-center gap-4">
              <div className="rounded-full bg-primary/10 p-4">
                <Microscope className="h-8 w-8 text-primary" />
              </div>
              <div className="text-center">
                <p className="font-medium">Ready to analyze?</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Upload images and detect eggs in seconds.
                </p>
              </div>
              <Button
                size="lg"
                onClick={() => navigate("/analyze")}
              >
                <FlaskConical className="mr-2 h-4 w-4" />
                Start Analysis
              </Button>
            </CardContent>
          </Card>

          {/* Recent analyses */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Recent Analyses
                </CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate("/recorded")}
                >
                  View all
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {error !== null && !loading ? (
                <ErrorState
                  message={error}
                  title="Failed to load dashboard"
                  onRetry={fetchStats}
                />
              ) : loading ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : stats?.recent_analyses.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <Microscope className="mb-2 h-6 w-6 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    No analyses yet. Run your first analysis to see results here.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {stats?.recent_analyses.map((batch) => (
                    <RecentItem key={batch.id} batch={batch} onClick={(id) => navigate(`/recorded?batch=${id}`)} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
