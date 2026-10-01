// PaginationBar — compact page window: first, last, current ±1, ellipses.

import {
    Pagination,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
} from '@/components/ui/pagination';

/** [1, 'ellipsis', 4, 5, 6, 'ellipsis', 12] for page 5 of 12. */
export function pageWindow(page: number, pageCount: number): Array<number | 'ellipsis'> {
    const items: Array<number | 'ellipsis'> = [];
    for (let i = 1; i <= pageCount; i++) {
        if (i === 1 || i === pageCount || Math.abs(i - page) <= 1) {
            items.push(i);
        } else if (items[items.length - 1] !== 'ellipsis') {
            items.push('ellipsis');
        }
    }
    return items;
}

interface PaginationBarProps {
    page: number;
    pageCount: number;
    onChange: (page: number) => void;
}

export function PaginationBar({ page, pageCount, onChange }: PaginationBarProps) {
    const atStart = page <= 1;
    const atEnd = page >= pageCount;
    return (
        <Pagination>
            <PaginationContent>
                <PaginationItem>
                    <PaginationPrevious
                        href="#"
                        onClick={(e) => {
                            e.preventDefault();
                            if (!atStart) onChange(page - 1);
                        }}
                        aria-disabled={atStart}
                        className={atStart ? 'pointer-events-none opacity-50' : undefined}
                    />
                </PaginationItem>
                {pageWindow(page, pageCount).map((item, idx) =>
                    item === 'ellipsis' ? (
                        <PaginationItem key={`e${idx}`}>
                            <PaginationEllipsis />
                        </PaginationItem>
                    ) : (
                        <PaginationItem key={item}>
                            <PaginationLink
                                href="#"
                                isActive={item === page}
                                onClick={(e) => {
                                    e.preventDefault();
                                    onChange(item);
                                }}
                            >
                                {item}
                            </PaginationLink>
                        </PaginationItem>
                    ),
                )}
                <PaginationItem>
                    <PaginationNext
                        href="#"
                        onClick={(e) => {
                            e.preventDefault();
                            if (!atEnd) onChange(page + 1);
                        }}
                        aria-disabled={atEnd}
                        className={atEnd ? 'pointer-events-none opacity-50' : undefined}
                    />
                </PaginationItem>
            </PaginationContent>
        </Pagination>
    );
}
