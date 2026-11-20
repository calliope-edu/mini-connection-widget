/**
 * Test-runner resolution hook: `@calliope-edu/ui` resolves to the stand-ins in
 * `test/ui-stub/` (why: see `test/ui-stub/index.js`). Only `pnpm test` loads
 * this; the shipped components import the real library.
 */
const stub = new URL('./ui-stub/index.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@calliope-edu/ui') return { url: stub, shortCircuit: true };
  return nextResolve(specifier, context);
}
