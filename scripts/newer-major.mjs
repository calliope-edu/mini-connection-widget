#!/usr/bin/env node
// Warns when calliope-ui has released a major version newer than the one the widget is tested
// against (CI and the release workflow test against the newest release within the pinned major).
//
//   node scripts/newer-major.mjs v0.4.0
//
// A new major is a breaking change in calliope-ui: the widget keeps working with its old major
// until someone moves the pin in devDependencies and the peerDependencies range up, once the
// checks pass with it. This only points that out; it never fails.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { newestReleaseTag, parseVersion } from './release-version.mjs';

const REPO = 'https://github.com/calliope-edu/calliope-ui.git';

/**
 * The warning to show, or null when the tested tag is in the newest major.
 * @param {string} tested the release tag tested against, `vX.Y.Z`
 * @param {string[]} tags calliope-ui's tag names
 * @returns {string | null}
 */
export function newerMajorWarning(tested, tags) {
  const testedVersion = parseVersion(tested);
  if (!testedVersion) throw new Error(`"${tested}" is not a release tag vX.Y.Z`);
  const newest = newestReleaseTag(tags);
  const newestVersion = newest ? parseVersion(newest) : null;
  if (!newest || !newestVersion || newestVersion[0] <= testedVersion[0]) return null;
  return (
    `calliope-ui ${newest} is out, a new major; the widget is tested against ${tested}. ` +
    `Move the pin in devDependencies and the peerDependencies range of @calliope-edu/ui up ` +
    `once the checks pass with it.`
  );
}

function main() {
  const [tested] = process.argv.slice(2);
  if (!tested) throw new Error('Usage: newer-major.mjs vX.Y.Z');
  const tags = execFileSync('git', ['ls-remote', '--tags', REPO], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t')[1].replace(/^refs\/tags\//, '').replace(/\^\{\}$/, ''));
  const warning = newerMajorWarning(tested, tags);
  if (warning) console.log(process.env.GITHUB_ACTIONS ? `::warning::${warning}` : warning);
  else console.log(`${tested} is in calliope-ui's newest major.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
