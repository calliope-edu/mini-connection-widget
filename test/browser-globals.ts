/**
 * Side-effect import for a test that needs the browser-only wiring some
 * modules install at load time (`if (typeof window !== 'undefined')`). Import
 * it FIRST, before any src/ module, so it runs before they evaluate. Web
 * Serial is stubbed as present; nothing in the tests calls into it.
 */
const g = globalThis as Record<string, unknown>;
g.window ??= globalThis;
Object.defineProperty(globalThis.navigator, 'serial', { value: {}, configurable: true });
