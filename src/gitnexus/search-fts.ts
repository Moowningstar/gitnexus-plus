/**
 * The content half of a keyword search: the index's own full-text index.
 *
 * Split out of `search.ts` because the two halves answer different questions and
 * fail differently. The graph half (`CONTAINS` over names and paths, in `search.ts`)
 * returns declarations with line numbers; this half returns files whose *text*
 * mentions the word, and only when the manifest says the index has an FTS surface.
 * Everything here is written to return a stated reason instead of throwing: a
 * broken content index must cost the content pass, not the search.
 */

import type { SearchHit } from './search.js';
import { readLineNumber } from '../shell.js';

/**
 * The two adapter calls this module needs, structurally.
 *
 * `LbugAdapter` in `search.ts` satisfies it; declaring it here keeps the dependency
 * one-way (search.ts → search-fts.ts) instead of a module cycle for a type.
 */
export interface FtsAdapter {
  executeQuery?: (cypher: string) => Promise<unknown[]>;
  queryFTS?: (
    tableName: string,
    indexName: string,
    query: string,
    limit?: number,
    conjunctive?: boolean,
  ) => Promise<unknown[]>;
}
/** One row of `CALL SHOW_INDEXES()`, whichever shape the engine returns it in. */
interface CatalogIndex {
  table: string;
  index: string;
  type: string;
}

function readCatalogRow(value: unknown): CatalogIndex | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown> & unknown[];
  // LadybugDB answers this call positionally on some builds and by column name on
  // others; GitNexus's own catalog helpers accept both, so this one does too.
  const table = typeof row.table_name === 'string' ? row.table_name : row[0];
  const index = typeof row.index_name === 'string' ? row.index_name : row[1];
  const type = typeof row.index_type === 'string' ? row.index_type : row[2];
  if (typeof table !== 'string' || typeof index !== 'string' || index === '') return null;
  return { table, index, type: typeof type === 'string' ? type : '' };
}

/**
 * The FTS index to use for one table, from the database's own catalog.
 *
 * Reading the catalog instead of hardcoding `file_fts` keeps this correct across
 * content profiles (a `name`-only profile writes the same index name with fewer
 * columns) and across schema revisions that rename an index. Returns null when the
 * table has no FTS index, which is a reported state rather than "no matches".
 */
export function pickFtsIndexName(rows: unknown[], table: string): string | null {
  for (const value of rows) {
    const row = readCatalogRow(value);
    if (row === null || row.table !== table) continue;
    if (/fts|full.?text/i.test(row.type) || /_fts$/i.test(row.index)) return row.index;
  }
  return null;
}

/**
 * Map `QUERY_FTS_INDEX` rows to hits.
 *
 * `queryFTS` flattens the matched node onto the row and keeps `score`; the cypher it
 * runs returns `{ node, score }`. Both shapes are accepted because a stubbed adapter
 * (the tests) is not obliged to reproduce the flattening.
 */
export function mapFtsRows(rows: unknown[]): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const value of rows) {
    if (value === null || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const node =
      row.node !== null && typeof row.node === 'object'
        ? (row.node as Record<string, unknown>)
        : row;
    const name = typeof node.name === 'string' ? node.name : '';
    const filePath = typeof node.filePath === 'string' ? node.filePath : '';
    if (name === '' || filePath === '') continue;
    const label =
      typeof node.label === 'string' && node.label !== ''
        ? node.label
        : typeof node.kind === 'string' && node.kind !== ''
          ? node.kind
          : 'File';
    hits.push({
      kind: label,
      name,
      filePath,
      startLine: readLineNumber(node.startLine),
      endLine: readLineNumber(node.endLine),
    });
  }
  return hits;
}

/** Lowercased, slash-normalized path, for "is this file already in the list". */
function pathKey(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

/**
 * Append FTS hits after the graph hits, skipping files the graph already lists.
 *
 * A content match in a file whose symbol already matched adds a second row for the
 * same place without adding information — the symbol row is strictly more specific
 * (it names the declaration and can open at its line). The graph page wins.
 */
export function mergeHits(
  page: SearchHit[],
  extra: SearchHit[],
  limit: number,
): { results: SearchHit[]; truncated: boolean } {
  const seen = new Set(page.map((hit) => pathKey(hit.filePath)));
  const results = [...page];
  let truncated = false;
  for (const hit of extra) {
    if (results.length >= limit) {
      truncated = true;
      break;
    }
    const key = pathKey(hit.filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(hit);
  }
  return { results, truncated };
}

/**
 * Whether a failure is the FTS extension failing to load, as opposed to any other
 * query error.
 *
 * These messages are the only ones that mean "retry without FTS": a missing-tables
 * or missing-index error is handled by `queryFTS` returning no rows, a busy database
 * has its own `index-busy` report, and a genuine query error must stay an error. The
 * patterns are anchored loosely on purpose — LadybugDB has shipped at least three
 * wordings for the "extension is not registered" case.
 */
export function isFtsLoadFailure(message: string): boolean {
  return /FTS[ _]extension|libfts|fts\.lbug_extension|QUERY_FTS_INDEX is not defined|Failed to load library/i.test(
    message,
  );
}

/** The outcome of the content half: hits, whether it really ran, and why not. */
export interface FtsSearchOutcome {
  hits: SearchHit[];
  ran: boolean;
  failure: string | null;
}

/**
 * Run the FTS content pass against the file index of one table.
 *
 * Must be called inside `withLbugDb`'s operation: the adapter's `queryFTS` reads the
 * connection that call opened. Every failure is returned rather than thrown — the
 * graph half of the same search already succeeded, and losing it because a content
 * index is broken would trade a working answer for an error card.
 */
export async function searchViaFts(
  adapter: FtsAdapter,
  query: string,
  limit: number,
): Promise<FtsSearchOutcome> {
  if (adapter.executeQuery === undefined || adapter.queryFTS === undefined) {
    return {
      hits: [],
      ran: false,
      failure: 'GitNexus 的适配器没有提供 FTS 调用，本次只匹配符号名与文件路径。',
    };
  }
  let indexName: string | null;
  try {
    indexName = pickFtsIndexName(await adapter.executeQuery('CALL SHOW_INDEXES() RETURN *'), 'File');
  } catch (cause) {
    return {
      hits: [],
      ran: false,
      failure: `读不到数据库的索引目录，本次只匹配符号名与文件路径：${messageOf(cause)}`,
    };
  }
  if (indexName === null) {
    return {
      hits: [],
      ran: false,
      failure: '索引里没有 File 表的 FTS 索引，本次只匹配符号名与文件路径，不搜索正文。',
    };
  }
  try {
    return {
      hits: mapFtsRows(await adapter.queryFTS('File', indexName, query, limit)),
      ran: true,
      failure: null,
    };
  } catch (cause) {
    return {
      hits: [],
      ran: false,
      failure: `FTS 正文检索失败，本次只匹配符号名与文件路径：${messageOf(cause)}`,
    };
  }
}
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
