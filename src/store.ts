/**
 * Vanilla store primitives — Svelte-`subscribe` compatible.
 *
 * The store contract here is identical to Svelte's `Readable`/`Writable`, so
 * Svelte components can still use `$store` reactivity directly. React or
 * Vue consumers wrap `subscribe` with `useSyncExternalStore` / a watcher.
 *
 * Kept dependency-free on purpose — when this directory is extracted into its
 * own repo (`@calliope-edu/calliope-connection`) the package needs to work in
 * any framework, not just Svelte.
 */

export type Subscriber<T> = (value: T) => void;
export type Unsubscriber = () => void;
export type Updater<T> = (value: T) => T;

export interface Readable<T> {
  subscribe(run: Subscriber<T>): Unsubscriber;
}

export interface Writable<T> extends Readable<T> {
  set(value: T): void;
  update(updater: Updater<T>): void;
}

export function writable<T>(initial: T): Writable<T> {
  let value = initial;
  const subs = new Set<Subscriber<T>>();
  const set = (v: T) => {
    if (Object.is(value, v)) return;
    value = v;
    for (const s of subs) s(v);
  };
  return {
    subscribe(run) {
      subs.add(run);
      run(value);
      return () => { subs.delete(run); };
    },
    set,
    update(fn) { set(fn(value)); },
  };
}

/** One-shot read — useful for "branch on current value, don't re-render." */
export function get<T>(store: Readable<T>): T {
  let v: T;
  const unsub = store.subscribe((x) => { v = x; });
  unsub();
  return v!;
}
