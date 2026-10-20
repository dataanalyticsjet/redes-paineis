export const PUBLICATION_SUMMARY_LIMIT = 1;
export const PUBLICATION_HISTORY_LIMIT = 50;

export type PublicationHead = {
  publicationId: string;
  version: number;
  contractVersion?: number;
  publishedAt: string | null;
  visibleRowCount: number;
  periodStart: string | null;
  periodEnd: string | null;
};

/** Keep latest-publication badges for all sources and detail only for the selected one. */
export function publicationRequestPlan<Source extends { source_id: string }>(
  sources: readonly Source[],
  selectedSourceId: string,
): { source: Source; limit: number }[] {
  return sources.map((source) => ({
    source,
    limit: source.source_id === selectedSourceId ? PUBLICATION_HISTORY_LIMIT : PUBLICATION_SUMMARY_LIMIT,
  }));
}

/** A cached history is reusable only while its latest published record is unchanged. */
export function publicationHeadChanged(
  current: PublicationHead | null | undefined,
  next: PublicationHead | null | undefined,
): boolean {
  if (!current || !next) return current !== next;
  return current.publicationId !== next.publicationId
    || current.version !== next.version
    || current.contractVersion !== next.contractVersion
    || current.publishedAt !== next.publishedAt
    || current.visibleRowCount !== next.visibleRowCount
    || current.periodStart !== next.periodStart
    || current.periodEnd !== next.periodEnd;
}

/** Load independent metadata items without letting one rejected request cancel the rest. */
export async function loadIndependently<Item, Result>(
  items: readonly Item[],
  load: (item: Item) => Promise<Result>,
  onLoaded: (item: Item, result: Result) => void,
  onFailed: (item: Item, error: unknown) => void,
  concurrency = items.length,
): Promise<void> {
  if (items.length === 0) return;
  const workerCount = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  let nextIndex = 0;

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) continue;
      try {
        onLoaded(item, await load(item));
      } catch (error) {
        onFailed(item, error);
      }
    }
  }));
}
