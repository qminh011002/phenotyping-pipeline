// ChartCard — the frame every dashboard chart sits in: title, one-line
// subtitle, optional controls, and a chart ⇄ table switch. The table is the
// chart's accessible twin: every plotted value is readable without hovering.

import { useState, type ReactNode } from 'react';
import { ChartNoAxesColumn, Table2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ChartCardProps {
    title: string;
    subtitle?: ReactNode;
    /** Controls that change what the chart shows (not data filters). */
    controls?: ReactNode;
    /** Tabular rendering of the same data. Enables the view switch. */
    table?: ReactNode;
    children: ReactNode;
    className?: string;
}

export function ChartCard({
    title,
    subtitle,
    controls,
    table,
    children,
    className,
}: ChartCardProps) {
    const [showTable, setShowTable] = useState(false);
    return (
        <section className={cn('panel flex min-w-0 flex-col', className)}>
            <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-4">
                <div className="min-w-0">
                    <h2 className="text-sm font-semibold">{title}</h2>
                    {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {controls}
                    {table && (
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setShowTable((v) => !v)}
                            aria-pressed={showTable}
                            aria-label={showTable ? 'Show chart' : 'Show data table'}
                            title={showTable ? 'Show chart' : 'Show data table'}
                            className="text-muted-foreground"
                        >
                            {showTable ? <ChartNoAxesColumn /> : <Table2 />}
                        </Button>
                    )}
                </div>
            </header>
            <div className="min-w-0 flex-1 px-5 pt-4 pb-5">
                {showTable && table ? table : children}
            </div>
        </section>
    );
}

/** Compact table used for chart table-views. */
export function DataTable({
    columns,
    rows,
}: {
    columns: Array<{ label: string; numeric?: boolean }>;
    rows: Array<Array<ReactNode>>;
}) {
    return (
        <div className="max-h-72 overflow-auto rounded-md border border-border">
            <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-muted text-muted-foreground">
                    <tr>
                        {columns.map((c) => (
                            <th
                                key={c.label}
                                scope="col"
                                className={cn('px-3 py-2 font-medium', c.numeric && 'text-right')}
                            >
                                {c.label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-border">
                    {rows.map((row, i) => (
                        <tr key={i}>
                            {row.map((cell, j) => (
                                <td
                                    key={j}
                                    className={cn(
                                        'px-3 py-1.5',
                                        columns[j]?.numeric && 'text-right tabular-nums',
                                    )}
                                >
                                    {cell}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/** Centered placeholder for a chart with nothing to plot. */
export function ChartEmpty({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div
            className={cn(
                'flex h-48 items-center justify-center rounded-lg border border-dashed border-border px-6 text-center text-sm text-muted-foreground',
                className,
            )}
        >
            {children}
        </div>
    );
}
