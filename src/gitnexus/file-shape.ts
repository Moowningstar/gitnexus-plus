/**
 * Byte-level shape of one file: is it text, is it minified, how big is it.
 *
 * Split out of `coverage.ts` because the coverage module had grown into the
 * repository's largest host file, and because these three answers are what the
 * *rules* need — the report assembler should not have to open files to decide
 * whether to warn about one. Keeping them here also keeps `judgeMinified` free of
 * any dependency on the report types, so `coverage-rules.ts` can call it without
 * importing `coverage.ts` back.
 */

import fs from 'node:fs/promises';

/** Bytes sampled from a file's head when judging its shape. */
const MINIFIED_SAMPLE_BYTES = 64 * 1024;

/** Average characters per line above which a file is treated as minified. */
const MINIFIED_AVG_LINE_THRESHOLD = 500;

/** Control-byte share above which a sample is treated as binary. */
const BINARY_CONTROL_RATIO = 0.3;

/**
 * What a byte-level probe concluded about one oversized file.
 *
 * `binary` is decided before `suspect`: a first revision tested only "no newlines ⇒
 * one enormous line", which flagged every binary asset as minified.
 */
export interface FileShape {
  /** Machine data, not text at all. */
  binary: boolean;
  /** Minified: text, but written as one enormous line. */
  suspect: boolean;
  /** Characters per line (meaningless when binary). */
  avgLineLength: number;
  estimatedLines: number | null;
  sampledBytes: number;
}

/**
 * Judge whether an oversized file is binary or minified by reading its head.
 *
 * This exists because line count alone is a liar on binary data. A first revision
 * skipped the probe and inferred "one long line ⇒ minified", which flagged every
 * binary asset as minified. Measured on a real repository: a 380 MB `.glb` model
 * and a 30 MB `.glb` reported "single-line ≈ 399 230 584 chars" — absurd on its
 * face, and worse than absurd in effect, because it told the reader that 97 % of
 * the repository's skipped bytes were compressed *source*. They were 3D assets that
 * could never have held a symbol.
 *
 * A binary file has few newlines for a reason that has nothing to do with
 * minification, so no line-length statistic over it means anything. The test is
 * git's own: a NUL byte in the head means binary. A control-byte ratio backs it up
 * for machine formats that happen to avoid NUL.
 *
 * The extrapolation is deliberately crude — newline density in the head is assumed
 * to hold for the rest — and only ever produces a *warning*, never an exclusion.
 *
 * @param {string} absolutePath
 * @param {number} size
 * @returns {Promise<FileShape>}
 */
export async function judgeMinified(absolutePath: string, size: number): Promise<FileShape> {
  const want = Math.max(1, Math.min(size, MINIFIED_SAMPLE_BYTES));
  let handle;
  try {
    handle = await fs.open(absolutePath, 'r');
    const buffer = Buffer.allocUnsafe(want);
    const { bytesRead } = await handle.read(buffer, 0, want, 0);
    const sample = buffer.subarray(0, bytesRead);
    const sampled = sample.length;
    if (sampled === 0) {
      return { binary: false, suspect: false, avgLineLength: 0, estimatedLines: 0, sampledBytes: 0 };
    }

    let newlines = 0;
    let control = 0;
    for (let i = 0; i < sampled; i += 1) {
      const byte = sample[i];
      if (byte === 0x0a) newlines += 1;
      // NUL is decisive on its own (git's rule); other C0 controls accumulate as
      // corroboration. Tab, LF and CR are ordinary text bytes and excluded.
      if (byte === 0x00) {
        return { binary: true, suspect: false, avgLineLength: 0, estimatedLines: null, sampledBytes: sampled };
      }
      if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) control += 1;
    }
    if (control / sampled > BINARY_CONTROL_RATIO) {
      return { binary: true, suspect: false, avgLineLength: 0, estimatedLines: null, sampledBytes: sampled };
    }

    // Whole file sampled: the line count is exact.
    if (size <= sampled) {
      const lines = newlines + 1;
      const avg = size / lines;
      return {
        binary: false,
        suspect: avg > MINIFIED_AVG_LINE_THRESHOLD,
        avgLineLength: avg,
        estimatedLines: lines,
        sampledBytes: sampled,
      };
    }
    // Extrapolated: newlines/byte in the head is assumed to hold throughout, so
    // average line length is simply sample length over newlines in the sample.
    if (newlines === 0) {
      return { binary: false, suspect: true, avgLineLength: size, estimatedLines: 1, sampledBytes: sampled };
    }
    const avg = sampled / newlines;
    return {
      binary: false,
      suspect: avg > MINIFIED_AVG_LINE_THRESHOLD,
      avgLineLength: avg,
      estimatedLines: Math.round(size / avg),
      sampledBytes: sampled,
    };
  } catch {
    return { binary: false, suspect: false, avgLineLength: 0, estimatedLines: null, sampledBytes: 0 };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Path shapes that conventionally hold build output. Applied only to files that
 * already exceeded the size cap, where the combination is high-signal.
 *
 * This exists because the minified heuristic alone is not enough: measured on
 * material-ui, the three skipped files are generated but **multi-line** (75 263 /
 * 10 757 / 32 317 lines, 31/70/44 chars per line) so `judgeMinified` correctly
 * declines to call them minified — yet they are stil compiled output sitting in
 * the byte totals. Verified by counting newlines over the whole file after a
 * PowerShell line count wrongly reported "1 line" for a 2.3 MB file.
 */
const GENERATED_PATH_PATTERNS = Object.freeze([
  /(^|\/)(dist|build|out|vendor|generated|__generated__|coverage)\//i,
  /(^|\/)lib\//i,
  /\.min\./i,
  /\.generated\./i,
  /\.g\.(cs|ts|js)$/i,
  /\.bundle\.(js|mjs|cjs)$/i,
]);

/**
 * @param {string} filePath repo-relative
 * @returns {boolean} whether the path conventionally denotes build output
 */
export function looksGenerated(filePath: string): boolean {
  return GENERATED_PATH_PATTERNS.some((re) => re.test(filePath));
}

/** @param {number} bytes */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
