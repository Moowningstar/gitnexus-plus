/**
 * Version-line arithmetic: parsing, ordering, and the supported-range verdict.
 *
 * These tests exist because the panel used to print two version strings and leave the
 * reader to decide whether the pair was a problem. The pair `1.6.12 / 1.6.13-rc.159`
 * is supported; `1.6.12 / 2.0.0` is not; and `rc.9` vs `rc.159` is exactly where
 * string order disagrees with semver order.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  SUPPORTED_PEER_RANGE,
  compareVersionLines,
  compareVersions,
  isSupportedVersion,
  parseVersion,
  versionLine,
  versionLineLabel,
} from '../../lib/gitnexus/version-lines.js';
import { check, section } from '../harness.mjs';

export async function versionLinesTests() {
  section('version lines: parsing and ordering');

  const parsed = parseVersion('1.6.13-rc.159');
  check(
    'a prerelease parses into numeric and identifier parts',
    parsed !== null && parsed.major === 1 && parsed.minor === 6 && parsed.patch === 13 && parsed.prerelease.join('.') === 'rc.159',
    JSON.stringify(parsed),
  );
  check('a release parses with an empty prerelease', (parseVersion('1.6.12')?.prerelease.length ?? -1) === 0);
  check('a build suffix is ignored', parseVersion('1.6.12+build.7')?.patch === 12);
  check('nonsense is not a version', parseVersion('latest') === null && parseVersion('1.6') === null && parseVersion('') === null && parseVersion(null) === null);

  const order = (a, b) => compareVersions(parseVersion(a), parseVersion(b));
  check('rc.159 sorts after rc.9, unlike string order', order('1.6.13-rc.159', '1.6.13-rc.9') > 0);
  check('a prerelease sorts before its release', order('1.6.13-rc.159', '1.6.13') < 0);
  check('1.6.12 sorts before 1.6.13-rc.0', order('1.6.12', '1.6.13-rc.0') < 0);
  check('1.6.13-rc.0 is the floor of the candidate line', order('1.6.13-rc.0', '1.6.12') > 0);
  check('equal versions compare equal', order('1.6.12', '1.6.12') === 0);
  check('a longer prerelease sorts after its prefix', order('1.6.13-rc.0.1', '1.6.13-rc.0') > 0);

  section('version lines: which line a version belongs to');
  check('1.6.12 is the stable line', versionLine('1.6.12') === 'stable');
  check('1.6.99 is still the stable line', versionLine('1.6.99') === 'stable');
  check('1.6.13-rc.159 is the candidate line', versionLine('1.6.13-rc.159') === 'candidate');
  check('1.6.14-rc.1 is the candidate line', versionLine('1.6.14-rc.1') === 'candidate');
  check('2.0.0 is outside every supported line', versionLine('2.0.0') === 'other');
  check('1.6.11 is below the stable floor', versionLine('1.6.11') === 'other');
  check('an rc below the candidate floor is outside', versionLine('1.6.12-rc.1') === 'other');
  check('a host version is not a GitNexus version', versionLine('0.2.1-rc.3') === 'other');
  check('unparsable is unknown, never supported', versionLine('dev') === 'unknown' && !isSupportedVersion('dev'));
  check('both supported lines pass isSupportedVersion', isSupportedVersion('1.6.12') && isSupportedVersion('1.6.13-rc.159'));

  section('version lines: how the two sides relate');
  const same = compareVersionLines('1.6.12', '1.6.12');
  check('identical strings are same', same.relation === 'same');
  const crossing = compareVersionLines('1.6.12', '1.6.13-rc.159');
  check(
    'stable vs candidate is a cross-line, not an error',
    crossing.relation === 'cross-line' && crossing.indexedLine === 'stable' && crossing.installedLine === 'candidate',
    JSON.stringify(crossing),
  );
  check('two candidates compare as cross-line too', compareVersionLines('1.6.13-rc.9', '1.6.13-rc.159').relation === 'cross-line');
  check('an out-of-range CLI is named as such', compareVersionLines('1.6.12', '2.0.0').relation === 'cli-out-of-range');
  check('an out-of-range index is named as such', compareVersionLines('1.6.11', '1.6.12').relation === 'index-out-of-range');
  check('both out of range stays a single verdict', compareVersionLines('1.5.0', '2.0.0').relation === 'out-of-range');
  check(
    'a missing side is unknown, never cross-line',
    compareVersionLines(null, '1.6.12').relation === 'unknown' && compareVersionLines('1.6.12', '').relation === 'unknown',
  );
  check('the range is reported with every comparison', crossing.supportedRange === SUPPORTED_PEER_RANGE);

  section('version lines: the range is the peer range in package.json');
  const manifest = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
  check(
    'the peer range and the panel copy cannot drift apart',
    manifest.peerDependencies?.gitnexus === SUPPORTED_PEER_RANGE,
    `${manifest.peerDependencies?.gitnexus} vs ${SUPPORTED_PEER_RANGE}`,
  );

  section('version lines: labels');
  check('stable label', versionLineLabel('stable') === '稳定线');
  check('candidate label', versionLineLabel('candidate') === '候选线');
  check('other label', versionLineLabel('other') === '受支持范围外');
  check('unknown label', versionLineLabel('unknown') === '版本未知');
}
