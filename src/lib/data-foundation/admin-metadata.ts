/** Load independent metadata items without letting one rejected request cancel the rest. */
export async function loadIndependently<Item, Result>(
  items: readonly Item[],
  load: (item: Item) => Promise<Result>,
  onLoaded: (item: Item, result: Result) => void,
  onFailed: (item: Item, error: unknown) => void,
): Promise<void> {
  await Promise.all(items.map(async (item) => {
    try {
      onLoaded(item, await load(item));
    } catch (error) {
      onFailed(item, error);
    }
  }));
}
