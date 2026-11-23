#!/usr/bin/env node
// Next release version for the release workflow (.github/workflows/release.yml).
//
//   node scripts/release-version.mjs patch|minor|major|X.Y.Z [--write]
//
// Starts from the higher of `version` in package.json and the newest tag vX.Y.Z, bumps it (or
// takes the given X.Y.Z, which must be higher), prints the new version without `v`, and with
// --write sets it in package.json.
//
// Same rules as calliope-ui's scripts/release-version.mjs (one release scheme for both
// packages); the SemVer helpers are copied rather than shared, since calliope-ui only shares
// its resolve-calliope-deps action with other repos.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * @param {string} text `1.2.3` or `v1.2.3`
 * @returns {[number, number, number] | null}
 */
export function parseVersion(text) {
  const m = VERSION.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 */
export function compareVersions(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * The newest of the given tag names that is a release tag `vX.Y.Z`. Other tags (pre-releases
 * such as the old `v0.1.0-mini-v1v2-webdfu`, anything else) are ignored.
 * @param {string[]} tags
 * @returns {string | null}
 */
export function newestReleaseTag(tags) {
  /** @type {{ tag: string, version: [number, number, number] } | null} */
  let best = null;
  for (const tag of tags) {
    if (!tag.startsWith('v')) continue;
    const version = parseVersion(tag);
    if (!version) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { tag, version };
  }
  return best ? best.tag : null;
}

/**
 * @param {{ packageVersion: string, tags: string[], bump: string }} options
 * @returns {string} the new version, `X.Y.Z`
 */
export function nextVersion({ packageVersion, tags, bump }) {
  const fromPackage = parseVersion(packageVersion);
  if (!fromPackage) throw new Error(`package.json has version "${packageVersion}", not X.Y.Z`);
  const newestTag = newestReleaseTag(tags);
  const fromTag = newestTag ? parseVersion(newestTag) : null;
  const current = fromTag && compareVersions(fromTag, fromPackage) > 0 ? fromTag : fromPackage;

  const explicit = parseVersion(bump);
  if (explicit) {
    if (compareVersions(explicit, current) <= 0) {
      throw new Error(`${bump} is not higher than the current ${current.join('.')}`);
    }
    if (tags.includes(`v${explicit.join('.')}`)) throw new Error(`v${bump} exists already`);
    return explicit.join('.');
  }
  const [major, minor, patch] = current;
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump "${bump}": use patch, minor, major or X.Y.Z.`);
}

/**
 * Sets the top-level `version` in the package.json text, keeping its formatting.
 * @param {string} text
 * @param {string} version
 */
export function setPackageVersion(text, version) {
  const pattern = /^(\s*"version"\s*:\s*)"[^"]*"/m;
  if (!pattern.test(text)) throw new Error('package.json has no "version" field');
  return text.replace(pattern, (_, key) => `${key}"${version}"`);
}

function main() {
  const [bump, ...flags] = process.argv.slice(2);
  if (!bump) throw new Error('Usage: release-version.mjs patch|minor|major|X.Y.Z [--write]');
  const text = readFileSync('package.json', 'utf8');
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const version = nextVersion({ packageVersion: JSON.parse(text).version, tags, bump });
  if (flags.includes('--write')) writeFileSync('package.json', setPackageVersion(text, version));
  console.log(version);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
