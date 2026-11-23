// Release versions for the release workflow (scripts/release-version.mjs) and its warning about
// a newer calliope-ui major (scripts/newer-major.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newestReleaseTag, nextVersion, setPackageVersion } from './release-version.mjs';

test('the first release starts from package.json (0.2.1 → 0.3.0)', () => {
  const tags = ['v0.1.0-mini-v1v2-webdfu'];
  assert.equal(nextVersion({ packageVersion: '0.2.1', tags, bump: 'minor' }), '0.3.0');
  assert.equal(nextVersion({ packageVersion: '0.2.1', tags, bump: 'patch' }), '0.2.2');
});

test('starts from the newest tag when it is higher than package.json', () => {
  const tags = ['v0.3.0', 'v0.10.0', 'v0.9.3', 'calliope-v2.0.0'];
  assert.equal(nextVersion({ packageVersion: '0.3.0', tags, bump: 'patch' }), '0.10.1');
  assert.equal(nextVersion({ packageVersion: '0.3.0', tags, bump: 'major' }), '1.0.0');
});

test('takes an explicit version only when it is higher and new', () => {
  assert.equal(nextVersion({ packageVersion: '0.2.1', tags: [], bump: '0.3.5' }), '0.3.5');
  assert.throws(() => nextVersion({ packageVersion: '0.2.1', tags: [], bump: '0.2.1' }));
  assert.throws(() => nextVersion({ packageVersion: '0.2.1', tags: [], bump: 'huge' }));
});

test('newest release tag ignores pre-releases and other tags', () => {
  const tags = ['v0.1.0-mini-v1v2-webdfu', 'v0.3.0', 'v0.10.2', 'calliope-v3.0.0', 'latest'];
  assert.equal(newestReleaseTag(tags), 'v0.10.2');
  assert.equal(newestReleaseTag(['v0.1.0-mini-v1v2-webdfu']), null);
});

test('sets the top-level version and keeps the formatting', () => {
  const text = '{\n  "name": "x",\n  "version": "0.2.1",\n  "dependencies": {}\n}\n';
  assert.equal(setPackageVersion(text, '0.3.0'), text.replace('0.2.1', '0.3.0'));
  assert.throws(() => setPackageVersion('{}', '0.3.0'));
});

test('warns only when calliope-ui has a newer major than the one tested', async () => {
  const { newerMajorWarning } = await import('./newer-major.mjs');
  assert.equal(newerMajorWarning('v0.4.0', ['v0.1.0', 'v0.4.0']), null);
  assert.equal(newerMajorWarning('v0.4.0', ['v0.4.0', 'v1.0.0-beta.1']), null);
  assert.match(newerMajorWarning('v0.4.0', ['v0.4.0', 'v1.0.0']) ?? '', /v1\.0\.0 is out/);
  assert.throws(() => newerMajorWarning('6faa0c1', ['v1.0.0']));
});
