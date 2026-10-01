// Routes the Recorded feature links to — one place so the list card and the
// detail header can't drift apart.

/** Detail view of one batch. */
export function batchPath(batchId: string): string {
    return `/recorded?batch=${batchId}`;
}

/** Upload page in append mode: new images are added to an existing batch. */
export function addImagesPath(batchId: string, organism: string): string {
    return `/analyze/upload?batch=${batchId}&type=${organism}&mode=upload`;
}
