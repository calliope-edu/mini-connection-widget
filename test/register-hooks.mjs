/**
 * Loaded via `node --import ./test/register-hooks.mjs` from the `test` script:
 * installs the resolution hook that lets src/ modules use extensionless
 * relative imports under the Node test runner (see `ts-resolve.mjs`).
 */
import { register } from 'node:module';

register('./ts-resolve.mjs', import.meta.url);
