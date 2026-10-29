/**
 * Pure helpers for the shape of a MakeCode (pxt) project — no DOM, no stores,
 * no iframe. Everything here reads or rewrites `text['pxt.json']`.
 *
 * These were duplicated across calliope-campus (inline in MakeCode.svelte) and
 * Teachable-Calliope-Svelte (src/lib/makecode/header.ts). The pxt.json contract
 * is the same for both, so it lives here once.
 */

/**
 * The subset of `@microbit/makecode-embed`'s MakeCodeProject we actually touch.
 * Declared structurally so this module needs no dependency on the embed package
 * — callers can pass their MakeCodeProject straight in.
 */
export interface MakeCodeProjectLike {
  text?: Record<string, string> | undefined;
  header?: unknown;
}

/** Calliope mini v3 target id on makecode.calliope.cc. */
export const CALLIOPE_TARGET = 'calliopemini';
/**
 * Target version stamped into project headers. A project handed to the editor
 * in controller=2 mode must carry a header with a target/targetVersion the
 * editor recognises, or the workspace won't bind it.
 */
export const CALLIOPE_TARGET_VERSION = '8.1.5';

/** pxt.json dependency keys that select the board revision rather than an extension. */
const BOARD_REVISION_DEPS = ['v1', 'v2', 'v3'] as const;
/** pxt.json dependency keys that are never shown as user-removable extensions. */
const NON_EXTENSION_DEPS = ['core', ...BOARD_REVISION_DEPS] as const;

export type CalliopeHardwareVersion = 1 | 2 | 3;

export interface MakeCodeExtension {
  id: string;
  name: string;
  version?: string;
}

function randomHex(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/** A guid in the shape pxt uses for `header.id`. */
export function randomHeaderId(): string {
  return `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}`;
}

export interface CreateHeaderOptions {
  /** Force a specific header id (e.g. a host-side stable program key). */
  id?: string;
  /** Defaults to 'blocksprj'. */
  editor?: string;
  target?: string;
  targetVersion?: string;
}

/**
 * A minimal, complete pxt project header. pxt is unforgiving about missing
 * fields here — several of these look redundant but the workspace reads them.
 */
export function createCalliopeHeader(name: string, opts: CreateHeaderOptions = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    target: opts.target ?? CALLIOPE_TARGET,
    targetVersion: opts.targetVersion ?? CALLIOPE_TARGET_VERSION,
    name,
    meta: {},
    editor: opts.editor ?? 'blocksprj',
    pubId: '',
    pubCurrent: false,
    _rev: null,
    id: opts.id ?? randomHeaderId(),
    recentUse: now,
    modificationTime: now,
    cloudUserId: null,
    cloudCurrent: false,
    cloudVersion: null,
    cloudLastSyncTime: 0,
    isDeleted: false,
    githubCurrent: false,
    saveId: null,
  };
}

function readPxtJson(project: MakeCodeProjectLike | null | undefined): Record<string, any> | null {
  const raw = project?.text?.['pxt.json'];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    console.warn('[makecode] pxt.json is not valid JSON', err);
    return null;
  }
}

/**
 * Return a copy of `project` whose pxt.json has been replaced by `pxtJson`.
 * Copies rather than mutating: callers hold these objects in reactive state and
 * an in-place edit is invisible to it.
 */
function withPxtJson(
  project: MakeCodeProjectLike,
  pxtJson: Record<string, any>,
): MakeCodeProjectLike {
  return {
    ...project,
    text: { ...(project.text ?? {}), 'pxt.json': JSON.stringify(pxtJson, null, 2) },
  };
}

/**
 * Extensions the user added, i.e. every pxt.json dependency that isn't `core`
 * or a board-revision selector.
 */
export function parseExtensions(project: MakeCodeProjectLike | null | undefined): MakeCodeExtension[] {
  const pxtJson = readPxtJson(project);
  if (!pxtJson) return [];
  const deps = pxtJson.dependencies;
  if (!deps || typeof deps !== 'object') return [];
  return Object.entries(deps as Record<string, unknown>)
    .filter(([key]) => !(NON_EXTENSION_DEPS as readonly string[]).includes(key))
    .map(([id, version]) => ({ id, name: id, version: version as string }));
}

/** Drop one extension from pxt.json. Returns the project unchanged if absent. */
export function removeExtension(
  project: MakeCodeProjectLike,
  extensionId: string,
): MakeCodeProjectLike {
  const pxtJson = readPxtJson(project);
  if (!pxtJson?.dependencies || !(extensionId in pxtJson.dependencies)) {
    return project;
  }
  const dependencies = { ...pxtJson.dependencies };
  delete dependencies[extensionId];
  return withPxtJson(project, { ...pxtJson, dependencies });
}

/**
 * Which Calliope mini revision the project targets, read off the `v1`/`v2`/`v3`
 * dependency. `null` when none is pinned.
 *
 * Note this is how pxt-calliope models the board revision — unlike pxt-arcade,
 * where the selected hardware lives in an in-editor module variable and can
 * only be preselected through the `hw=` URL param.
 */
export function getHardwareVersion(
  project: MakeCodeProjectLike | null | undefined,
): CalliopeHardwareVersion | null {
  const pxtJson = readPxtJson(project);
  const deps = pxtJson?.dependencies;
  if (!deps || typeof deps !== 'object') return null;
  for (const key of BOARD_REVISION_DEPS) {
    if (deps[key] === '*') return Number(key.slice(1)) as CalliopeHardwareVersion;
  }
  return null;
}

/** Pin the project to a Calliope mini revision, replacing any existing pin. */
export function setHardwareVersion(
  project: MakeCodeProjectLike,
  version: CalliopeHardwareVersion,
): MakeCodeProjectLike {
  if (![1, 2, 3].includes(version)) {
    console.warn('[makecode] ignoring invalid hardware version', version);
    return project;
  }
  const pxtJson = readPxtJson(project);
  if (!pxtJson) return project;
  const dependencies = { ...(pxtJson.dependencies ?? {}) };
  for (const key of BOARD_REVISION_DEPS) delete dependencies[key];
  dependencies[`v${version}`] = '*';
  return withPxtJson(project, { ...pxtJson, dependencies });
}

/**
 * Whether a stored project is complete enough to hand to pxt. A project without
 * a parseable pxt.json crashes the editor's workspace load, so hosts drop these
 * from the sync and show a recovery affordance instead.
 */
export function isStructurallyValidProject(value: unknown): boolean {
  const project = value as MakeCodeProjectLike | null;
  if (!project || typeof project !== 'object') return false;
  if (!project.text || typeof project.text !== 'object') return false;
  return readPxtJson(project) !== null;
}
