/**
 * Wire shapes shared by the host and the browser half.
 *
 * Declared as an ambient module rather than a source file so both programs can import it
 * without compiling it twice: the host's `rootDir` is `src` and the client's is
 * `src/client`, so any shared *source* path is outside one of them. These are types only,
 * so every import is erased at compile time — nothing reaches the client bundle and
 * nothing is emitted into `lib/`.
 *
 * Only shapes that are genuinely identical belong here. The analyse run, for example, is
 * not: the host requires `repoPath` and `attempts` while the client tolerates older hosts
 * that omit `force`/`repairFts`, and merging them would loosen the host's guarantees.
 */
declare module 'dsh-gitnexus-wire' {
  /** One commit touching a specific file. */
  export interface FileHistoryCommit {
    sha: string;
    shortSha?: string;
    date: string;
    author: string;
    subject: string;
    insertions: number;
    deletions: number;
  }

  /** A single file's bounded commit history. */
  export interface FileHistory {
    path: string;
    available: boolean;
    days: number;
    commits: number;
    insertions: number;
    deletions: number;
    timeline: FileHistoryCommit[];
    reason: string | null;
    readAt?: string;
  }

  /** One commit's patch for a single file, bounded for the panel. */
  export interface CommitDiff {
    path: string;
    sha: string;
    available: boolean;
    patch: string;
    truncated: boolean;
    reason: string | null;
    readAt?: string;
  }
}
