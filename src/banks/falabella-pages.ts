/** One rendered page of a paginated CMR movements tab. */
export interface CmrPageSnapshot<Row> {
  /** "error" is the bank's own «No pudimos cargar tus últimos movimientos» panel (its API answered 500) */
  state: "rows" | "error" | "empty";
  rows: Row[];
  /** Text of every row: identifies the page, to tell when the table actually changed */
  signature: string;
  hasNext: boolean;
}

/** What the collector needs from the browser page; faked in tests. */
export interface CmrPager<Row> {
  read(): Promise<CmrPageSnapshot<Row>>;
  /** Clicks "next"; false when there was nothing to click */
  next(): Promise<boolean>;
  /** Clicks the bank's "Reintentar" button */
  retry(): Promise<void>;
  /** Resolves once the tab shows something other than `previous` (new rows or the error panel), or on timeout */
  waitForChange(previous: string): Promise<CmrPageSnapshot<Row>>;
}

export interface CollectOptions {
  /** Tab name used in logs and errors, e.g. "por facturar" */
  tab: string;
  maxPages: number;
  retryDelaysMs: readonly number[];
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

/** Rows the bank lists without a posting date */
export const PENDING_DATE = "pendiente";

function incompleteError(tab: string, pageNumber: number, reason: string): Error {
  return new Error(
    `Falabella no entregó todos los movimientos ${tab} de la tarjeta (página ${pageNumber}: ${reason}). No se guardó nada: reintenta la sincronización.`,
  );
}

/**
 * Reads every page of a CMR tab, or throws: a partial list must never pass as the whole tab, because the caller
 * reconciles stored movements against it. The bank's API fails often (HTTP 500 → error panel with a "Reintentar"
 * button), on the first load or on any page, so each page is retried before giving up.
 */
export async function collectCmrPages<Row extends { date: string }>(pager: CmrPager<Row>, options: CollectOptions): Promise<Row[]> {
  const { tab, maxPages, retryDelaysMs, sleep, log } = options;
  const all: Row[] = [];
  const seenPages = new Set<string>();
  let firstPagePending = "";
  let snapshot = await pager.read();

  for (let pageNumber = 1, reads = 1; ; pageNumber++, reads++) {
    if (pageNumber > maxPages || reads > maxPages * 2) throw incompleteError(tab, pageNumber, `más de ${maxPages} páginas`);

    for (const wait of retryDelaysMs) {
      if (snapshot.state !== "error") break;
      log(`  [CMR pag] ${tab} page ${pageNumber}: bank error, retrying in ${wait / 1000}s`);
      await sleep(wait);
      await pager.retry();
      snapshot = await pager.waitForChange("");
    }
    if (snapshot.state === "error") throw incompleteError(tab, pageNumber, "el banco respondió con error");

    if (snapshot.state === "rows" && seenPages.has(snapshot.signature)) {
      // After a retry the bank may show an earlier page again: skip what was already read
      log(`  [CMR pag] ${tab}: page already read, moving on`);
      pageNumber--;
    } else {
      seenPages.add(snapshot.signature);
      // The pending-confirmation rows can sit in a table of their own that every page repeats
      const pendingSignature = JSON.stringify(snapshot.rows.filter((r) => r.date === PENDING_DATE));
      const repeatedPending = pageNumber > 1 && pendingSignature === firstPagePending;
      if (pageNumber === 1) firstPagePending = pendingSignature;
      all.push(...(repeatedPending ? snapshot.rows.filter((r) => r.date !== PENDING_DATE) : snapshot.rows));
      log(`  [CMR pag] ${tab} page ${pageNumber}: ${snapshot.rows.length} rows`);
    }

    if (!snapshot.hasNext) return all;

    const previous = snapshot.signature;
    if (!(await pager.next())) throw incompleteError(tab, pageNumber + 1, "no se pudo avanzar de página");
    snapshot = await pager.waitForChange(previous);
    if (snapshot.state === "empty") throw incompleteError(tab, pageNumber + 1, "la página llegó vacía");
    if (snapshot.state === "rows" && snapshot.signature === previous) throw incompleteError(tab, pageNumber + 1, "la página no cargó");
  }
}
