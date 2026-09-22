/**
 * Test-runner resolution hook: let a `.ts` source use extensionless relative
 * imports under `node --experimental-strip-types`.
 *
 * The src/ tree is written for bundlers (Vite/esbuild), which resolve
 * `./ram-scan` to `ram-scan.ts` on their own. Node's ESM resolver does not —
 * so a module that imports a sibling could not be loaded by the test runner at
 * all, which is why the mailbox codecs used to be strictly dependency-free
 * leaves. That constraint cost a shared RAM sweep (`src/ram-scan.ts`), so lift
 * it here instead: on a resolution miss for a relative, extensionless
 * specifier, retry once with `.ts`.
 *
 * Nothing about the shipped package changes — this file is only loaded by
 * `pnpm test` (`--import ./test/ts-resolve.mjs`).
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    const extensionless = !/\.[cm]?[jt]sx?$/.test(specifier);
    if (relative && extensionless) return nextResolve(`${specifier}.ts`, context);
    throw err;
  }
}
