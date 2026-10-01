import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { getDashboardOverview } from '@/services/api';
import type { Organism } from '@/types/api';

/** Dashboard analytics for one window + organism slice.
 *
 * While a new slice loads, the previous one stays on screen (dimmed by the
 * page) instead of flashing skeletons. */
export function useDashboard(days: number, organism: Organism | null) {
    return useQuery({
        queryKey: ['dashboard-overview', days, organism],
        queryFn: ({ signal }) => getDashboardOverview({ days, organism }, signal),
        placeholderData: keepPreviousData,
        staleTime: 30_000,
    });
}
