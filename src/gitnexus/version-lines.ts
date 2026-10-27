/**
 * Version-line arithmetic without a semver dependency.
 *
 * Two versions are in play at any time: the index records the CLI that built it
 * (`runnerIdentity.cliVersion`) and the host runs whatever `gitnexus` it can find.
 * `readCompatibility` answers "are these the same build" by string equality — that
 * stays, because storage versions are not range-comparable. The question this module
 * answers is the one the panel could not answer before: when they differ, is that a
 * *supported* crossing between the stable and the candidate line, or a real error?
 *
 * The supported window is the peer range in `package.json`:
 * `^1.6.12 || >=1.6.13-rc.0 <2.0.0`. npm hides prereleases from plain ranges, so the
 * second arm exists only to say "a candidate build is accepted".
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dotted prerelease identifiers, empty for a release (`[]`). */
  prerelease: string[];
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse `1.6.13-rc.159`. Returns null for anything semver would not accept. */
export function parseVersion(text: string | null | undefined): ParsedVersion | null {
  if (typeof text !== 'string') return null;
  const match = VERSION_PATTERN.exec(text.trim());
  if (match === null) return null;
  const [, major, minor, patch, pre] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre === undefined ? [] : pre.split('.'),
  };
}

/** Semver identifier order: numeric identifiers compare numerically and sort before
 * alphanumeric ones; a shorter identifier list sorts before a longer one. */
function compareIdentifiers(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) return Number(a) - Number(b);
  if (numericA) return -1;
  if (numericB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Order two parsed versions. The one nuance that matters for this repo is that
 * `1.6.13-rc.159` is *after* `1.6.13-rc.9` — string order says the opposite.
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  // A release sorts after any prerelease of the same major.minor.patch.
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const order = compareIdentifiers(x, y);
    if (order !== 0) return order;
  }
  return 0;
}

/** The peer range, in one place so the panel and the checks cannot drift apart. */
export const SUPPORTED_PEER_RANGE = '^1.6.12 || >=1.6.13-rc.0 <2.0.0';

const STABLE_FLOOR: ParsedVersion = { major: 1, minor: 6, patch: 12, prerelease: [] };
const CANDIDATE_FLOOR: ParsedVersion = { major: 1, minor: 6, patch: 13, prerelease: ['rc', '0'] };
const CEILING: ParsedVersion = { major: 2, minor: 0, patch: 0, prerelease: [] };

/** Which release line a version belongs to. */
export type VersionLine = 'stable' | 'candidate' | 'other' | 'unknown';

/**
 * Classify a version string.
 *
 * `stable` is a release at or above 1.6.12 below 2.0.0; `candidate` is a prerelease at
 * or above 1.6.13-rc.0 below 2.0.0. Anything else — including the `0.2.1-rc.x` host
 * versions that are *not* GitNexus versions — is `other`, never silently accepted.
 */
export function versionLine(text: string | null | undefined): VersionLine {
  const parsed = parseVersion(text);
  if (parsed === null) return 'unknown';
  if (compareVersions(parsed, CEILING) >= 0) return 'other';
  if (parsed.prerelease.length === 0) {
    return compareVersions(parsed, STABLE_FLOOR) >= 0 ? 'stable' : 'other';
  }
  return compareVersions(parsed, CANDIDATE_FLOOR) >= 0 ? 'candidate' : 'other';
}

/** Whether a version falls inside the peer range at all. */
export function isSupportedVersion(text: string | null | undefined): boolean {
  const line = versionLine(text);
  return line === 'stable' || line === 'candidate';
}

/** How two versions relate, once both are known. */
export type VersionRelation =
  | 'same'
  | 'cross-line'
  | 'index-out-of-range'
  | 'cli-out-of-range'
  | 'out-of-range'
  | 'unknown';

export interface VersionComparison {
  relation: VersionRelation;
  indexedLine: VersionLine;
  installedLine: VersionLine;
  supportedRange: string;
}

function normalize(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Relate the index's build CLI to the installed CLI.
 *
 * Exactly one verdict per pair, and `unknown` is never upgraded to a comfortable one:
 * an unparsable or missing side stays `unknown` rather than being called compatible.
 */
export function compareVersionLines(
  indexedBy: string | null | undefined,
  installed: string | null | undefined,
): VersionComparison {
  const supportedRange = SUPPORTED_PEER_RANGE;
  const indexText = normalize(indexedBy);
  const cliText = normalize(installed);
  if (indexText === null || cliText === null) {
    return { relation: 'unknown', indexedLine: 'unknown', installedLine: 'unknown', supportedRange };
  }
  const indexedLine = versionLine(indexText);
  const installedLine = versionLine(cliText);
  if (indexText === cliText) {
    return { relation: 'same', indexedLine, installedLine, supportedRange };
  }
  const indexSupported = indexedLine === 'stable' || indexedLine === 'candidate';
  const cliSupported = installedLine === 'stable' || installedLine === 'candidate';
  let relation: VersionRelation = 'out-of-range';
  if (indexSupported && cliSupported) relation = 'cross-line';
  else if (!indexSupported && cliSupported) relation = 'index-out-of-range';
  else if (indexSupported && !cliSupported) relation = 'cli-out-of-range';
  return { relation, indexedLine, installedLine, supportedRange };
}

/** One short Chinese label per line, for panel copy. */
export function versionLineLabel(line: VersionLine): string {
  switch (line) {
    case 'stable':
      return '稳定线';
    case 'candidate':
      return '候选线';
    case 'other':
      return '受支持范围外';
    default:
      return '版本未知';
  }
}
