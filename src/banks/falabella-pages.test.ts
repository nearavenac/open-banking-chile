import { describe, it, expect } from "vitest";
import { collectCmrPages, PENDING_DATE, type CmrPageSnapshot, type CmrPager } from "./falabella-pages.js";

interface Row {
  date: string;
  description: string;
}

const row = (description: string, date = "01-11-2026"): Row => ({ date, description });

function rowsPage(rows: Row[], hasNext: boolean): CmrPageSnapshot<Row> {
  return { state: "rows", rows, signature: rows.map((r) => `${r.date}|${r.description}`).join("\n"), hasNext };
}

const ERROR_PAGE: CmrPageSnapshot<Row> = { state: "error", rows: [], signature: "", hasNext: false };
const EMPTY_PAGE: CmrPageSnapshot<Row> = { state: "empty", rows: [], signature: "", hasNext: false };

/** A pager that shows `first` and then, after each next/retry, the following snapshot of `afterActions`. */
function fakePager(first: CmrPageSnapshot<Row>, afterActions: CmrPageSnapshot<Row>[]) {
  let current = first;
  const queue = [...afterActions];
  const calls = { next: 0, retry: 0 };
  const pager: CmrPager<Row> = {
    read: async () => current,
    next: async () => {
      calls.next++;
      current = queue.shift() ?? current;
      return true;
    },
    retry: async () => {
      calls.retry++;
      current = queue.shift() ?? current;
    },
    waitForChange: async () => current,
  };
  return { pager, calls };
}

const options = { tab: "por facturar", maxPages: 10, retryDelaysMs: [1, 1], sleep: async () => {}, log: () => {} };

describe("collectCmrPages", () => {
  it("reads every page until the next button is disabled", async () => {
    // given
    const { pager } = fakePager(rowsPage([row("a"), row("b")], true), [rowsPage([row("c")], true), rowsPage([row("d")], false)]);

    // when
    const rows = await collectCmrPages(pager, options);

    // then
    expect(rows.map((r) => r.description)).toEqual(["a", "b", "c", "d"]);
  });

  it("returns an empty list when the tab has no movements", async () => {
    // given
    const { pager } = fakePager(EMPTY_PAGE, []);

    // when / then
    expect(await collectCmrPages(pager, options)).toEqual([]);
  });

  it("retries the bank's error panel on the first load", async () => {
    // given
    const { pager, calls } = fakePager(ERROR_PAGE, [ERROR_PAGE, rowsPage([row("a")], false)]);

    // when
    const rows = await collectCmrPages(pager, options);

    // then
    expect(rows.map((r) => r.description)).toEqual(["a"]);
    expect(calls.retry).toBe(2);
  });

  it("retries an error in the middle and keeps the pages already read", async () => {
    // given: page 2 fails once, then loads
    const { pager } = fakePager(rowsPage([row("a")], true), [ERROR_PAGE, rowsPage([row("b")], false)]);

    // when
    const rows = await collectCmrPages(pager, options);

    // then
    expect(rows.map((r) => r.description)).toEqual(["a", "b"]);
  });

  it("skips a page shown again after a retry sends the bank back to page 1", async () => {
    // given: page 2 fails, the retry shows page 1 again, then page 2
    const first = rowsPage([row("a")], true);
    const { pager } = fakePager(first, [ERROR_PAGE, first, rowsPage([row("b")], false)]);

    // when
    const rows = await collectCmrPages(pager, options);

    // then
    expect(rows.map((r) => r.description)).toEqual(["a", "b"]);
  });

  it("throws instead of returning a partial list when the bank keeps failing", async () => {
    // given
    const { pager } = fakePager(rowsPage([row("a")], true), [ERROR_PAGE, ERROR_PAGE, ERROR_PAGE]);

    // when / then
    await expect(collectCmrPages(pager, options)).rejects.toThrow(/no entregó todos los movimientos por facturar.*página 2/);
  });

  it("throws when the next page never loads", async () => {
    // given: the table stays the same after clicking next
    const first = rowsPage([row("a")], true);
    const { pager } = fakePager(first, [first]);

    // when / then
    await expect(collectCmrPages(pager, options)).rejects.toThrow(/la página no cargó/);
  });

  it("throws when the next page arrives empty", async () => {
    // given
    const { pager } = fakePager(rowsPage([row("a")], true), [EMPTY_PAGE]);

    // when / then
    await expect(collectCmrPages(pager, options)).rejects.toThrow(/llegó vacía/);
  });

  it("throws when the tab has more pages than the limit", async () => {
    // given: every page is new and always has a next one
    let n = 0;
    const pager: CmrPager<Row> = {
      read: async () => rowsPage([row(`r${n}`)], true),
      next: async () => { n++; return true; },
      retry: async () => {},
      waitForChange: async () => rowsPage([row(`r${n}`)], true),
    };

    // when / then
    await expect(collectCmrPages(pager, { ...options, maxPages: 3 })).rejects.toThrow(/más de 3 páginas/);
  });

  it("reads once a pending table that every page repeats", async () => {
    // given: the same pending row is rendered on both pages
    const pending = row("hold", PENDING_DATE);
    const { pager } = fakePager(rowsPage([pending, row("a")], true), [rowsPage([pending, row("b")], false)]);

    // when
    const rows = await collectCmrPages(pager, options);

    // then
    expect(rows.map((r) => r.description)).toEqual(["hold", "a", "b"]);
  });

  it("keeps identical rows that are real repeats", async () => {
    // given: the same purchase twice on one page and once more on the next
    const { pager } = fakePager(rowsPage([row("x"), row("x")], true), [rowsPage([row("x"), row("y")], false)]);

    // when / then
    expect((await collectCmrPages(pager, options)).map((r) => r.description)).toEqual(["x", "x", "x", "y"]);
  });
});
