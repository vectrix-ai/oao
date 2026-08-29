import type { PageResult } from "./types";

/**
 * Walks every page of a console list until the reported total is covered.
 *
 * Views that reason about a whole inventory (which agents pin a preset,
 * which agents can be delegates) must not stop at the first page.
 */
export async function listAllPages<T>(
  fetchPage: (page: number) => Promise<PageResult<T>>,
): Promise<readonly T[]> {
  const items: T[] = [];
  let page = 1;
  for (;;) {
    const result = await fetchPage(page);
    items.push(...result.data);
    const done =
      result.data.length === 0 ||
      items.length >= result.total ||
      result.data.length < result.pageSize;
    if (done) return items;
    page += 1;
  }
}
