/**
 * Per-iframe MakeCodeFrameDriver lifecycle for a controller=2 embedded editor.
 *
 * One handle per mounted iframe. By default a compiled hex is routed to the
 * widget's own `flashCalliope` (the Download button) and `downloadHexFile`
 * ("Download as file"), so the centralized USB/BLE connection owns the device
 * and the host doesn't hand-roll either operation.
 *
 * State is per-handle rather than a module singleton, so several editors can
 * coexist on one page.
 */
import {
  MakeCodeFrameDriver,
  type MakeCodeProject,
  type ShareResult,
} from '@microbit/makecode-embed/vanilla';
import { flashCalliope } from '../flash';
import { downloadHexFile } from '../helpers';

export interface MakeCodeDownload {
  name: string;
  hex: string;
}

/** The three editor languages pxt can switch between. */
export type MakeCodeMode = 'blocks' | 'javascript' | 'python';

export interface DriverHandle {
  driver: MakeCodeFrameDriver;
  /** Replace the project list MakeCode will receive on the next workspacesync. */
  setPendingProjects: (projects: MakeCodeProject[]) => void;
  dispose: () => void;
}

export interface CreateDriverOptions {
  iframe: HTMLIFrameElement;
  /**
   * Identifies this host to pxt's controller handshake. Use one stable id per
   * app (e.g. 'CalliopeCampus', 'CalliopeTeachable').
   */
  controllerId: string;
  /**
   * Projects to hand to MakeCode on the initial workspacesync. The first
   * `workspacesync` from the iframe asks for the entire list of projects the
   * workspace should know about, and MakeCode stores them indexed by
   * `header.id` in its in-memory workspace — crucially without rewriting the id
   * (unlike the `importproject` path, which calls `installAsync` and generates a
   * fresh guid). Pass ALL programs you want MakeCode to know about here, then
   * use `driver.openHeader(id)` to switch between them.
   */
  initialProjects: MakeCodeProject[];
  /** Called whenever MakeCode saves the workspace. */
  onWorkspaceSave: (project: MakeCodeProject) => void;
  /** Called when the editor content is first ready. */
  onEditorReady?: () => void;
  /** Called when the controller=2 sync completes (workspaceLoaded). */
  onWorkspaceLoaded?: () => void;
  /** Optional hook fired before flashing; return false to cancel. */
  beforeFlash?: (download: MakeCodeDownload) => boolean | void;
  /**
   * Replace the default flash-on-download behaviour entirely. Use when the host
   * wants to do something other than hand the hex to the connected device.
   */
  onDownload?: (download: MakeCodeDownload) => void;
  /** Replace the default "Download as file" behaviour. */
  onSave?: (download: MakeCodeDownload) => void;
  /**
   * Last word on the file name a compiled hex is downloaded under (both the
   * flash path's download fallback and the explicit "Download as file"). pxt
   * derives its name from the project's own header name, which a host may only
   * sync into the iframe at workspacesync — so the host, which always knows the
   * current program title, gets to correct it. Identity when unset.
   */
  resolveDownloadName?: (pxtName: string) => string;
  /** Optional log tag prefix. */
  tag?: string;
}

export function createMakeCodeDriver(opts: CreateDriverOptions): DriverHandle {
  const tag = opts.tag ?? '[makecode]';
  let pending: MakeCodeProject[] = opts.initialProjects.slice();

  // Never let a broken name resolver break the download itself — fall back to
  // whatever pxt proposed.
  const resolveName = (pxtName: string): string => {
    try {
      return opts.resolveDownloadName?.(pxtName) || pxtName;
    } catch (err) {
      console.warn(tag, 'resolveDownloadName failed', err);
      return pxtName;
    }
  };

  const driver = new MakeCodeFrameDriver(
    {
      controllerId: opts.controllerId,
      initialProjects: async () => {
        console.log(tag, 'initialProjects requested', { count: pending.length });
        return pending.slice();
      },
      onEditorContentLoaded: () => {
        console.log(tag, 'onEditorContentLoaded');
        opts.onEditorReady?.();
      },
      onWorkspaceLoaded: () => {
        console.log(tag, 'onWorkspaceLoaded — controller=2 sync complete');
        opts.onWorkspaceLoaded?.();
      },
      onWorkspaceSave: (ev) => {
        if (!ev.project) return;
        opts.onWorkspaceSave(ev.project);
      },
      onDownload: (d) => {
        const name = resolveName(d.name);
        console.log(tag, 'onDownload', { name, pxtName: d.name, hexLen: d.hex?.length });
        if (opts.beforeFlash?.({ ...d, name }) === false) return;
        if (opts.onDownload) {
          opts.onDownload({ ...d, name });
          return;
        }
        void flashCalliope(d.hex, name);
      },
      // "Download as file" (the explicit menu action, distinct from the main
      // Download-and-flash button). In controller=2 pxt does NOT write the file
      // itself — it posts a `{ save, name }` message and leaves it to the host,
      // so without this handler the menu entry appears dead.
      onSave: (s) => {
        const name = resolveName(s.name);
        console.log(tag, 'onSave', { name, pxtName: s.name, hexLen: s.hex?.length });
        if (opts.onSave) {
          opts.onSave({ ...s, name });
          return;
        }
        downloadHexFile(s.hex, name);
      },
    },
    () => opts.iframe,
  );

  driver.initialize();

  return {
    driver,
    setPendingProjects: (projects) => {
      pending = projects.slice();
    },
    dispose: () => {
      try {
        driver.dispose();
      } catch {
        /* ignore */
      }
    },
  };
}

export type { MakeCodeProject, ShareResult };
