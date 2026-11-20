/**
 * Test-runner load hook: compile a `.svelte` component for the server, so a
 * test can `render()` it from `svelte/server` and assert on the HTML.
 *
 * Only the markup and script matter for that — the `<style lang="scss">`
 * blocks would need a SCSS preprocessor the Svelte compiler doesn't have, so
 * they're dropped before compiling. TypeScript in `<script lang="ts">` is
 * stripped by the Svelte 5 compiler itself.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compile } from 'svelte/compiler';

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.svelte')) return nextLoad(url, context);
  const filename = fileURLToPath(url);
  const source = (await readFile(filename, 'utf8')).replace(/<style[\s\S]*?<\/style>/g, '');
  const { js } = compile(source, { filename, generate: 'server' });
  return { format: 'module', source: js.code, shortCircuit: true };
}
