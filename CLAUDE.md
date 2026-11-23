# CLAUDE.md

## Branches

- Work happens on `calliope-main`: branch off `calliope-main` and merge back into it. There is no
  other long-lived branch; `master` is the old line and is not worked on any more.
- Every commit on `calliope-main` reaches the dev channel (dev builds of the editors, campus-dev)
  without a further step, so keep it releasable.
- A release tag `vX.Y.Z` is what goes live. Tags are cut only by the release workflow
  (`gh workflow run release.yml -f bump=patch|minor|major`), never by hand; it also commits the
  version in `package.json`. Bump `major` for breaking changes (a removed or renamed export,
  store field, component prop or label key), `minor` for additions, `patch` for fixes. Details:
  README.md, "Branches and releases".
- Release order: calliope-ui, then the widget. A widget change that needs a new calliope-ui
  component or prop waits for a calliope-ui release; CI checks the widget against the newest one.

## calliope-ui

- `peerDependencies` states the calliope-ui releases the widget works with; the pin under
  `devDependencies` only serves local development. Widen the range only after `pnpm check`
  passes against the new release.
- `pnpm test` renders the UI against stand-ins (`test/ui-stub/`); `pnpm check` (svelte-check)
  type-checks `src/` against the real calliope-ui. Run both.
