// Keyword search: the query box, the one request it sends, and the list it renders.
//
// Split out of `CoveragePanel` because it is the one part of that component that is
// completely independent of the report: it has its own route, its own failure text,
// and its own reset rules. Keeping it here means the panel body only has to pass the
// project path and the session, and the sequence-number guard below lives next to the
// state it protects.
import * as React from 'react';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import { fileResourceAddress, openResource, openResourceIn, routeUrl } from '../navigation';
import { ClientSearchHit } from '../types';

export interface KeywordSearchOptions {
  /** The project the search is scoped to, or null while the panel has not resolved one. */
  projectPath: string | null;
  /** Current session, needed to build the `dsh-resource://` address for "open". */
  sessionId: string | null;
}

/** The prop bag the view expects under its `search` key. */
export interface KeywordSearchState {
  query: string;
  onQueryChange: (value: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  searching: boolean;
  error: string | null;
  mode: 'graph' | 'text' | null;
  results: ClientSearchHit[] | null;
  total: number;
  truncated: boolean;
  contentSearch: boolean;
  warning: string | null;
  copied: string | null;
  onOpen: (hit: ClientSearchHit) => void;
  onCopy: (hit: ClientSearchHit) => void;
}

/**
 * One keyword search per explicit submit.
 *
 * No request on mount and no request per keystroke: a graph query is cheap but not
 * free, and the operator's typing is not a search intent until Enter or the button.
 * `seq` makes an older in-flight response a no-op, which is the difference between
 * "the last search wins" and a result list that flickers backwards.
 */
export function useKeywordSearch(options: KeywordSearchOptions): KeywordSearchState {
  const { projectPath, sessionId } = options;
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<ClientSearchHit[] | null>(null);
  const [mode, setMode] = React.useState<'graph' | 'text' | null>(null);
  const [total, setTotal] = React.useState(0);
  const [truncated, setTruncated] = React.useState(false);
  const [contentSearch, setContentSearch] = React.useState(false);
  const [warning, setWarning] = React.useState<string | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  /** Monotonic request id: a slower earlier search must not overwrite a newer one. */
  const seq = React.useRef(0);

  const runSearch = React.useCallback(async (): Promise<void> => {
    if (projectPath === null) return;
    const text = query.trim();
    if (text === '') {
      setResults(null);
      setError(null);
      return;
    }
    const ticket = ++seq.current;
    setSearching(true);
    setError(null);
    setCopied(null);
    try {
      const res = await fetch(
        routeUrl(
          `/api/gitnexus/search?repo=${encodeURIComponent(projectPath)}` +
            `&q=${encodeURIComponent(text)}&limit=20`,
        ),
      );
      const body = await res.json().catch(() => null);
      if (ticket !== seq.current) return;
      if (!body?.ok) {
        // A 404 without the route's own code means the host predates the search
        // route, not that the project is wrong: the panel's own project path is a
        // project root by construction.
        if (res.status === 404 && body?.code !== 'not-a-project') {
          throw new Error('当前宿主没有搜索路由；重启 DSH 后再试。');
        }
        throw new Error(
          typeof body?.message === 'string' ? body.message : `请求失败 (${res.status})`,
        );
      }
      const hits: ClientSearchHit[] = Array.isArray(body.results)
        ? (body.results as ClientSearchHit[]).filter(
            (hit): hit is ClientSearchHit =>
              hit !== null &&
              typeof hit === 'object' &&
              typeof hit.kind === 'string' &&
              typeof hit.name === 'string' &&
              typeof hit.filePath === 'string',
          )
        : [];
      setResults(hits);
      setMode(body.mode === 'text' ? 'text' : body.mode === 'graph' ? 'graph' : null);
      setTotal(typeof body.total === 'number' ? body.total : hits.length);
      setTruncated(body.truncated === true);
      setContentSearch(body.contentSearch === true);
      setWarning(typeof body.warning === 'string' ? body.warning : null);
    } catch (cause) {
      if (ticket !== seq.current) return;
      setResults(null);
      setError(String((cause as Error)?.message ?? cause));
    } finally {
      if (ticket === seq.current) setSearching(false);
    }
  }, [projectPath, query]);

  const clearSearch = React.useCallback((): void => {
    seq.current += 1;
    setQuery('');
    setResults(null);
    setMode(null);
    setTotal(0);
    setTruncated(false);
    setContentSearch(false);
    setWarning(null);
    setError(null);
    setSearching(false);
    setCopied(null);
  }, []);

  const copyHit = React.useCallback((hit: ClientSearchHit): void => {
    const text = `${hit.filePath}${hit.startLine !== null ? `:${hit.startLine}` : ''}`;
    const key = `${hit.kind}:${hit.filePath}:${hit.startLine ?? ''}:${hit.name}`;
    const write =
      typeof primitives.writeClipboard === 'function'
        ? primitives.writeClipboard
        : (value: string) => navigator.clipboard?.writeText(value);
    try {
      const outcome = write(text);
      if (outcome && typeof outcome.then === 'function') {
        outcome
          .then(() => {
            setCopied(key);
            setTimeout(() => setCopied(null), 1500);
          })
          .catch(() => setCopied(null));
      } else {
        setCopied(key);
        setTimeout(() => setCopied(null), 1500);
      }
    } catch {
      setCopied(null);
    }
  }, []);

  /**
   * Open a hit in the platform's file viewer at its line.
   *
   * The resource address is the same `dsh-resource://file/session/...` the built-in
   * file strip uses; `params.line` is what the chat's file links pass. If the
   * deployment has no right-sidebar controller (a headless profile, or a host older
   * than the service), opening is impossible — copy the `path:line` instead of
   * silently doing nothing, and say why.
   */
  const openHit = React.useCallback(
    (hit: ClientSearchHit): void => {
      setError(null);
      if (sessionId === null) {
        setError('未能定位当前会话，已复制路径。');
        copyHit(hit);
        return;
      }
      const address = fileResourceAddress(sessionId, hit.filePath);
      const target = hit.startLine === null ? undefined : { params: { line: hit.startLine } };
      try {
        if (openResourceIn !== null) {
          openResourceIn(sessionId, address, target);
          return;
        }
        if (openResource !== null) {
          openResource(address, target);
          return;
        }
      } catch {
        /* fall through to the copy path */
      }
      setError('当前宿主没有可用的文件打开能力，已复制路径。');
      copyHit(hit);
    },
    [sessionId, copyHit],
  );

  const onQueryChange = React.useCallback((value: string): void => {
    // Invalidate an in-flight search for the previous text: otherwise its response
    // can land after the edit and repopulate a list that no longer matches the box.
    // The sequence bump also makes its `finally` a no-op, so the spinner is cleared
    // here rather than by a response that no longer applies.
    seq.current += 1;
    setSearching(false);
    setQuery(value);
    setError(null);
    setResults(null);
    setMode(null);
  }, []);

  // A different project means the previous hits are another repository's symbols.
  React.useEffect(() => {
    clearSearch();
  }, [projectPath, clearSearch]);

  return {
    query,
    onQueryChange,
    onSubmit: () => void runSearch(),
    onClear: clearSearch,
    searching,
    error,
    mode,
    results,
    total,
    truncated,
    contentSearch,
    warning,
    copied,
    onOpen: openHit,
    onCopy: copyHit,
  };
}
