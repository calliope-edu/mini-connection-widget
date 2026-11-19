<script lang="ts">
  /**
   * Top-attached bar above an embedded MakeCode editor: language mode toggle,
   * share, the project's extensions, and the Calliope mini revision.
   *
   * Built from calliope-ui parts: `SegmentedControl` for the mode, an
   * `IconButton` to share, a `Popover` listing the extensions and a `Menu`
   * for the revision. Colours come from `--cui-*` tokens, so the bar follows
   * the surrounding theme (`theme` pins it), and every string is overridable
   * through `labels`.
   */
  import type { Snippet } from 'svelte';
  import {
    Button,
    IconButton,
    Menu,
    MenuRadioGroup,
    MenuRadioItem,
    Popover,
    SegmentedControl,
    type SegmentedOption,
  } from '@calliope-edu/ui';
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
    theme = 'inherit',
    modeSwitch = 'bar',
    surface = 'subtle',
    buttons = 'bar',
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
    /** calliope-ui theme of the bar (`data-theme`); `inherit` follows the page. */
    theme?: 'light' | 'dark' | 'inherit';
    /** Look of the mode switch (calliope-ui SegmentedControl variant): `bar`
     *  (the default; in the bar buttons' fill, so it stands off the bar like
     *  them), `pill` (Campus' black view switch) or `frame`. */
    modeSwitch?: 'pill' | 'frame' | 'bar';
    /** The surface the bar paints (calliope-ui `data-surface`): `subtle` (grey
     *  in the light theme, dark grey in the dark one; the default) or
     *  `default` (white / black). The bar controls take the other neutral:
     *  white on grey, grey on white, black on dark grey, dark grey on black. */
    surface?: 'subtle' | 'default';
    /** Look of Share, extensions and revision: `bar`, Campus' editor-bar
     *  buttons (the default), or `outline`, calliope-ui's secondary buttons. */
    buttons?: 'bar' | 'outline';
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
  const dataTheme = $derived(theme === 'inherit' ? undefined : theme);
  const buttonVariant = $derived(buttons === 'bar' ? 'bar' : 'secondary');
  const buttonSize = $derived(buttons === 'bar' ? 'm' : 's');
  const modeOptions = $derived<SegmentedOption[]>([
    { value: 'blocks', label: l.modeBlocks },
    { value: 'javascript', label: l.modeJavaScript },
    { value: 'python', label: l.modePython },
  ]);

  function selectVersion(version: CalliopeHardwareVersion) {
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

<!-- data-surface tells calliope-ui's bar controls which surface the bar
     paints, so they stand off it. -->
<div class="makecode-toolbar" data-theme={dataTheme} data-surface={surface}>
  <div class="bar-left"></div>

  <!-- Center: segmented mode toggle -->
  <div class="bar-center">
    <SegmentedControl
      label={l.programmingMode}
      variant={modeSwitch}
      size="s"
      options={modeOptions}
      value={currentMode}
      onValueChange={(v) => onModeChange(v as MakeCodeMode)}
    />
  </div>

  <!-- Right: share + extensions + Calliope mini revision -->
  <div class="bar-right">
    {#if showShare && onShare}
      <IconButton
        icon="share"
        label={sharing ? l.sharingInProgress : l.shareProgram}
        variant={buttonVariant}
        size={buttonSize}
        loading={sharing}
        onclick={() => onShare?.()}
      />
    {/if}

    {#if showExtensions}
      <Popover title={l.extensions} side="bottom" align="end" size="l">
        {#snippet trigger({ props })}
          <Button {...props} variant={buttonVariant} size={buttonSize} iconEnd="chevron-down" title={l.extensions}>
            {l.extensionsCount(extensionsCount)}
          </Button>
        {/snippet}

        {#if extensionsCount === 0}
          <p class="no-extensions">{l.noExtensionsAdded}</p>
        {:else}
          <ul class="extension-list">
            {#each extensions as extension (extension.id)}
              {@const githubUrl = getGitHubUrl(extension.version ?? '')}
              <li class="extension-item">
                <div class="extension-info">
                  <span class="extension-name">{extension.name || extension.id}</span>
                  {#if extension.version}
                    {@const versionInfo = parseExtensionVersion(extension.version)}
                    {#if versionInfo.type === 'github'}
                      <span class="extension-version">
                        <span class="maintainer">{versionInfo.maintainer}</span>/{versionInfo.repo}{#if versionInfo.commit}#{versionInfo.commit}{/if}
                      </span>
                    {:else}
                      <span class="extension-version">{versionInfo.formatted}</span>
                    {/if}
                  {/if}
                </div>
                {#if githubUrl}
                  <IconButton
                    icon="external-link"
                    label={l.openOnGithub}
                    size="s"
                    onclick={(e) => handleExtensionClick(extension, e)}
                  />
                {/if}
                {#if onExtensionRemoved}
                  <IconButton
                    icon="delete"
                    label={l.removeExtension}
                    size="s"
                    onclick={(e) => handleRemoveClick(extension.id, e)}
                  />
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </Popover>
    {/if}

    {#if showVersionSelector}
      <Menu align="end">
        {#snippet trigger({ props })}
          <Button {...props} variant={buttonVariant} size={buttonSize} iconEnd="chevron-down" title={l.calliopeMiniVersion}>
            {l.calliopeMiniVersionLabel(currentVersion)}
          </Button>
        {/snippet}
        <MenuRadioGroup
          label={l.calliopeMiniVersion}
          value={String(currentVersion)}
          onValueChange={(v) => selectVersion(Number(v) as CalliopeHardwareVersion)}
        >
          {#each VERSIONS as version (version)}
            <MenuRadioItem value={String(version)}>{l.calliopeMiniVersionLabel(version)}</MenuRadioItem>
          {/each}
        </MenuRadioGroup>
      </Menu>
    {/if}

    {#if barRightExtra}
      {@render barRightExtra()}
    {/if}
  </div>
</div>

<style>
  .makecode-toolbar[data-surface='default'] {
    background-color: var(--cui-surface-default);
  }

  .makecode-toolbar {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--cui-space-3);
    box-sizing: border-box;
    width: 100%;
    height: 3rem;
    padding: 0 var(--cui-space-3);
    border-bottom: var(--cui-border-width-hairline) solid var(--cui-border-subtle);
    background-color: var(--cui-surface-subtle);
    color: var(--cui-text-default);
    font-family: var(--cui-typography-body-font-family);
  }

  .bar-left {
    flex: 1 1 0;
    min-width: 0;
  }

  .bar-center {
    display: flex;
    flex: 0 0 auto;
    justify-content: center;
  }

  .bar-right {
    display: flex;
    flex: 1 1 0;
    align-items: center;
    justify-content: flex-end;
    gap: var(--cui-space-2);
    min-width: 0;
  }

  /* ---- Extensions panel ---- */
  .no-extensions {
    margin: 0;
    color: var(--cui-text-muted);
    font-size: var(--cui-typography-label-font-size);
  }

  .extension-list {
    display: flex;
    flex-direction: column;
    gap: var(--cui-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .extension-item {
    display: flex;
    align-items: center;
    gap: var(--cui-space-1);
  }

  .extension-info {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--cui-space-0-5);
    min-width: 0;
  }

  .extension-name {
    font-size: var(--cui-typography-label-font-size);
    font-weight: var(--cui-font-weight-medium);
  }

  .extension-version {
    overflow: hidden;
    color: var(--cui-text-muted);
    font-family: var(--cui-typography-code-font-family);
    font-size: var(--cui-typography-caption-font-size);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .extension-version .maintainer {
    font-weight: var(--cui-font-weight-semibold);
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
      gap: var(--cui-space-2);
      height: auto;
      min-height: 3rem;
      padding: var(--cui-space-2);
    }

    .bar-center {
      flex: 1 1 100%;
      order: -1;
    }

    .bar-left {
      flex: 1 1 auto;
    }

    .bar-right {
      flex: 0 1 auto;
      flex-wrap: wrap;
    }
  }
</style>
