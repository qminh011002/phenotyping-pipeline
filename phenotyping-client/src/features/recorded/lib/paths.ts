// Routes the Recorded feature links to — one place so the list card and the
// detail header can't drift apart.

/** Detail view of one batch. */
export function batchPath(batchId: string): string {
    return `/recorded?batch=${batchId}`;
}

/** Analytics view of one batch — same page, different main area. */
export function batchAnalyticsPath(batchId: string): string {
    return `/recorded?batch=${batchId}&view=analytics`;
}

function parse(path: string): URL {
    return new URL(path, 'http://app.invalid');
}

/** `path` is the Recorded list (any filter), not a batch. */
export function isRecordedListPath(path: string): boolean {
    const url = parse(path);
    return url.pathname === '/recorded' && !url.searchParams.has('batch');
}

/** `path` is the page of this batch, in either of its views. */
export function isBatchPagePath(path: string, batchId: string): boolean {
    const url = parse(path);
    return url.pathname === '/recorded' && url.searchParams.get('batch') === batchId;
}

/** `path` is the overview (not the analytics view) of this batch. */
export function isBatchOverviewPath(path: string, batchId: string): boolean {
    return isBatchPagePath(path, batchId) && parse(path).searchParams.get('view') === null;
}

/** Upload page in append mode: new images are added to an existing batch. */
export function addImagesPath(batchId: string, organism: string): string {
    return `/analyze/upload?batch=${batchId}&type=${organism}&mode=upload`;
}
