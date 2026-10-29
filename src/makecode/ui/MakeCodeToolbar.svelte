<script lang="ts">
  /**
   * Top-attached bar above an embedded MakeCode editor: language mode toggle,
   * share, the project's extensions, and the Calliope mini revision.
   *
   * Colours come from `--mkc-*` custom properties whose defaults reproduce
   * calliope-campus's dark bar; a host on a light surface (Teachable) sets them
   * on any ancestor. Icons are inline SVG so the package needs no icon plugin,
   * and every string is overridable through `labels`.
   */
  import type { Snippet } from 'svelte';
  import Popover, { closeAllPopovers } from './Popover.svelte';
  import { mergeMakeCodeLabels, type MakeCodeLabels } from './labels';
  import type { MakeCodeExtension, CalliopeHardwareVersion } from '../project';
  import type { MakeCodeMode } from '../driver';

  const VERSIONS: CalliopeHardwareVersion[] = [1, 2, 3];

  let {
    currentMode = 'blocks',
    currentVersion = 3,
    extensions = [],
    showExtensions = true,
    showVersionSelector = true,
    showShare = true,
    sharing = false,
    labels: labelOverrides,
    onModeChange,
    onVersionChange,
    onExtensionRemoved,
    onShare,
    barRightExtra,
  }: {
    currentMode?: MakeCodeMode;
    currentVersion?: number;
    extensions?: MakeCodeExtension[];
    showExtensions?: boolean;
    showVersionSelector?: boolean;
    showShare?: boolean;
    sharing?: boolean;
    labels?: Partial<MakeCodeLabels>;
    onModeChange: (mode: MakeCodeMode) => void;
    onVersionChange?: (version: CalliopeHardwareVersion) => void;
    onExtensionRemoved?: (extensionId: string) => void;
    onShare?: () => void;
    /**
     * Extra content appended to the right of the bar. Hosts use this to dock
     * the connection widget into the toolbar.
     */
    barRightExtra?: Snippet;
  } = $props();

  const l = $derived(mergeMakeCodeLabels(labelOverrides));
  const extensionsCount = $derived(extensions?.length ?? 0);

  function selectVersion(version: CalliopeHardwareVersion) {
    closeAllPopovers();
    onVersionChange?.(version);
  }

  interface ParsedVersion {
    type: 'github' | 'simple';
    maintainer?: string;
    repo?: string;
    commit?: string;
    formatted?: string;
  }

  /**
   * Split a pxt.json dependency spec for display. GitHub specs look like
   * `github:calliope-edu/pxt-tcs34725fn#af260ea…` and read much better as
   * maintainer / repo / short commit than as one long string.
   */
  function parseExtensionVersion(version: string): ParsedVersion {
    if (version === '*' || version === 'latest') {
      return { type: 'simple', formatted: 'latest' };
    }
    if (version.startsWith('github:')) {
      const [repoPath, commitOrBranch] = version.replace('github:', '').split('#');
      const [maintainer, repo] = repoPath.split('/');
      if (maintainer && repo) {
        return {
          type: 'github',
          maintainer,
          repo,
          commit: commitOrBranch ? commitOrBranch.substring(0, 12) : undefined,
        };
      }
    }
    return { type: 'simple', formatted: version };
  }

  function getGitHubUrl(version: string): string | null {
    if (!version.startsWith('github:')) return null;
    const [repoPath] = version.replace('github:', '').split('#');
    const [maintainer, repo] = repoPath.split('/');
    return maintainer && repo ? `https://github.com/${maintainer}/${repo}` : null;
  }

  function handleExtensionClick(extension: MakeCodeExtension, event: MouseEvent) {
    event.stopPropagation();
    const githubUrl = extension.version ? getGitHubUrl(extension.version) : null;
    if (githubUrl) window.open(githubUrl, '_blank', 'noopener');
  }

  function handleRemoveClick(extensionId: string, event: MouseEvent) {
    event.stopPropagation();
    onExtensionRemoved?.(extensionId);
  }
</script>

<div class="makecode-toolbar">
  <div class="bar-left"></div>

  <!-- Center: segmented mode toggle -->
  <div class="bar-center">
    <div class="mode-group" role="group" aria-label={l.programmingMode}>
      <button
        class="mode-segment"
        class:active={currentMode === 'blocks'}
        aria-pressed={currentMode === 'blocks'}
        onclick={() => onModeChange('blocks')}
      >
        {l.modeBlocks}
      </button>
      <button
        class="mode-segment"
        class:active={currentMode === 'javascript'}
        aria-pressed={currentMode === 'javascript'}
        onclick={() => onModeChange('javascript')}
      >
        {l.modeJavaScript}
      </button>
      <button
        class="mode-segment"
        class:active={currentMode === 'python'}
        aria-pressed={currentMode === 'python'}
        onclick={() => onModeChange('python')}
      >
        {l.modePython}
      </button>
    </div>
  </div>

  <!-- Right: share + extensions + Calliope mini revision -->
  <div class="bar-right">
    {#if showShare && onShare}
      <button
        class="bar-button share-button"
        title={l.shareProgram}
        disabled={sharing}
        onclick={() => onShare?.()}
      >
        <svg
          class="bar-button-icon"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
        </svg>
      </button>
    {/if}

    {#if showExtensions}
      <Popover minWidth="240px">
        {#snippet trigger(open)}
          <button class="bar-button" title={l.extensions} aria-expanded={open}>
            <span>{l.extensionsCount(extensionsCount)}</span>
          </button>
        {/snippet}

        {#if extensionsCount === 0}
          <div class="no-extensions">{l.noExtensionsAdded}</div>
        {:else}
          {#each extensions as extension (extension.id)}
            <div class="extension-item">
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="extension-main-area"
                onclick={(e) => handleExtensionClick(extension, e)}
                title={getGitHubUrl(extension.version ?? '') ? l.openOnGithub : ''}
              >
                <div class="extension-info">
                  <span class="extension-name">{extension.name || extension.id}</span>
                  {#if extension.version}
                    {@const versionInfo = parseExtensionVersion(extension.version)}
                    {#if versionInfo.type === 'github'}
                      <div class="extension-version github-version">
                        <span class="maintainer">{versionInfo.maintainer}</span>
                        <span class="separator">/</span>
                        <span class="repo">{versionInfo.repo}</span>
                        {#if versionInfo.commit}
                          <span class="separator">#</span>
                          <span class="commit">{versionInfo.commit}</span>
                        {/if}
                      </div>
                    {:else}
                      <span class="extension-version simple-version">{versionInfo.formatted}</span>
                    {/if}
                  {/if}
                </div>
                {#if getGitHubUrl(extension.version ?? '')}
                  <span class="github-link-icon">↗</span>
                {/if}
              </div>

              <button
                class="remove-button"
                onclick={(e) => handleRemoveClick(extension.id, e)}
                title={l.removeExtension}
              >
                ×
              </button>
            </div>
          {/each}
        {/if}
      </Popover>
    {/if}

    {#if showVersionSelector}
      <Popover minWidth="200px">
        {#snippet trigger(open)}
          <button class="bar-button" title={l.calliopeMiniVersion} aria-expanded={open}>
            <span>{l.calliopeMiniVersionLabel(currentVersion)}</span>
          </button>
        {/snippet}

        {#each VERSIONS as version (version)}
          <button
            class="dropdown-item"
            class:selected={currentVersion === version}
            role="menuitem"
            onclick={() => selectVersion(version)}
          >
            <span>{l.calliopeMiniVersionLabel(version)}</span>
          </button>
        {/each}
      </Popover>
    {/if}

    {#if barRightExtra}
      {@render barRightExtra()}
    {/if}
  </div>
</div>

<style lang="scss">
  .makecode-toolbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    height: 3rem;
    padding: 0 0.75rem;
    box-sizing: border-box;
    background: var(--mkc-toolbar-bg, #2d2e30);
    border-bottom: 1px solid var(--mkc-toolbar-border, rgba(0, 0, 0, 0.35));
    flex-shrink: 0;
  }

  .bar-left {
    flex: 1 1 0;
    min-width: 0;
  }

  .bar-center {
    flex: 0 0 auto;
    display: flex;
    justify-content: center;
  }

  .bar-right {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  /* ---- Center segmented mode toggle ---- */
  .mode-group {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    background: var(--mkc-mode-group-bg, #ffffff);
    border-radius: 8px;
  }

  .mode-segment {
    appearance: none;
    border: none;
    background: transparent;
    color: var(--mkc-mode-fg, #1b1c1d);
    padding: 0.35rem 0.9rem;
    border-radius: 6px;
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    line-height: 1.2;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 0.15s ease, color 0.15s ease;

    &:hover:not(.active) {
      background: var(--mkc-mode-hover-bg, #e8edeb);
    }
    &.active {
      background: var(--mkc-mode-active-bg, #1b1c1d);
      color: var(--mkc-mode-active-fg, #ffffff);
    }
    &:focus-visible {
      outline: 2px solid var(--mkc-focus, hsl(181, 57%, 53%));
      outline-offset: 1px;
    }
  }

  /* ---- Right single buttons ---- */
  .bar-button {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    height: 2.2rem;
    padding: 0 0.7rem;
    background: var(--mkc-button-bg, #1b1c1d);
    color: var(--mkc-button-fg, #ffffff);
    border: 1px solid var(--mkc-button-border, rgba(255, 255, 255, 0.55));
    border-radius: 8px;
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 0.15s ease, border-color 0.15s ease;

    &:hover:not(:disabled) {
      background: var(--mkc-button-hover-bg, #343537);
      border-color: var(--mkc-button-hover-border, #ffffff);
    }
    &:disabled {
      opacity: 0.55;
      cursor: default;
    }
    &:focus-visible {
      outline: 2px solid var(--mkc-focus, hsl(181, 57%, 53%));
      outline-offset: 1px;
    }
  }

  .bar-button-icon {
    flex-shrink: 0;
  }

  /* ---- Version list items ---- */
  .dropdown-item {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 0.5rem 1rem;
    border: none;
    background: transparent;
    color: var(--mkc-panel-fg, hsl(210, 4%, 11%));
    font-size: 0.875rem;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.15s ease-in-out;

    &:hover:not(.selected) {
      background: var(--mkc-panel-hover-bg, hsl(156, 12%, 92%));
    }
    &.selected {
      background: var(--mkc-panel-selected-bg, hsl(190, 12%, 61%));
      cursor: not-allowed;
    }
    &:focus-visible {
      outline: 2px solid var(--mkc-focus, hsl(181, 57%, 53%));
      outline-offset: 2px;
    }
  }

  /* ---- Extensions panel ---- */
  .no-extensions {
    padding: 0.75rem 1rem;
    color: #666;
    font-size: 0.875rem;
    font-style: italic;
    text-align: center;
  }

  .extension-item {
    display: flex;
    align-items: center;
    background: transparent;
    transition: background-color 0.2s ease;

    &:hover {
      background: rgba(0, 0, 0, 0.05);
    }
  }

  .extension-main-area {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: 1;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    gap: 0.375rem;

    &:hover {
      background: rgba(0, 0, 0, 0.05);
    }
  }

  .extension-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    flex: 1;
  }

  .extension-name {
    font-size: 0.8rem;
    font-weight: 500;
    color: #333;
  }

  .extension-version {
    font-size: 0.65rem;
    font-weight: 500;
    opacity: 0.8;
  }

  .simple-version {
    color: #888;
  }

  .github-version {
    display: flex;
    align-items: center;
    gap: 0;
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', 'Courier New', monospace;

    .maintainer {
      color: #6f42c1;
      font-weight: 600;
      transition: color 0.2s ease;
    }
    .separator {
      color: #666;
      margin: 0 1px;
    }
    .repo {
      color: #0366d6;
      font-weight: 500;
      transition: color 0.2s ease;
    }
    .commit {
      color: #28a745;
      font-weight: 400;
      opacity: 0.9;
      transition: color 0.2s ease;
    }
  }

  .extension-main-area:hover .github-version {
    .maintainer {
      color: #553c9a;
    }
    .repo {
      color: #0250bb;
    }
    .commit {
      color: #22863a;
    }
  }

  .github-link-icon {
    color: #666;
    font-size: 0.75rem;
    opacity: 0.7;
  }

  .remove-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    background: transparent;
    border: none;
    color: #dc3545;
    font-size: 1rem;
    font-weight: bold;
    cursor: pointer;
    transition: all 0.2s ease;
    border-radius: 2px;
    margin: 0.125rem;

    &:hover {
      background: rgba(220, 53, 69, 0.1);
      color: #c82333;
    }
    &:active {
      background: rgba(220, 53, 69, 0.2);
    }
  }

  /* Mobile responsive.
     On a single row the fixed-width center toggle (flex-shrink: 0) plus the
     nowrap side buttons overflow once space runs out, and the right group
     spills leftward over the center toggle. Below this breakpoint we wrap to
     two rows: the mode toggle takes its own full-width centered row, and the
     Share / Extensions / version buttons share the row below it. */
  @media (max-width: 768px) {
    .makecode-toolbar {
      flex-wrap: wrap;
      height: auto;
      min-height: 3rem;
      gap: 0.4rem;
      padding: 0.4rem;
    }

    .bar-center {
      order: -1;
      flex: 1 1 100%;
    }

    .bar-left {
      flex: 1 1 auto;
    }

    .bar-right {
      flex: 0 1 auto;
      flex-wrap: wrap;
      gap: 0.4rem;
    }

    .mode-segment {
      padding: 0.3rem 0.6rem;
      font-size: 0.78rem;
    }

    .bar-button {
      padding: 0 0.5rem;
      font-size: 0.78rem;
    }
  }
</style>
