/**
 * Default UI labels (German) for the MakeCode toolbar and share modal. Apps
 * override any subset via the `labels` prop to plug in their own i18n system —
 * calliope-campus passes paraglide messages, Teachable passes wuchale ones.
 *
 * Keys are flat and short on purpose, matching `src/ui/labels.ts`.
 */
export interface MakeCodeLabels {
  // Mode toggle
  programmingMode: string;
  modeBlocks: string;
  modeJavaScript: string;
  modePython: string;

  // Toolbar buttons
  share: string;
  shareProgram: string;
  sharingInProgress: string;
  extensions: string;
  /** e.g. `(n) => n === 1 ? '1 Erweiterung' : \`${n} Erweiterungen\`` */
  extensionsCount: (count: number) => string;
  noExtensionsAdded: string;
  openOnGithub: string;
  removeExtension: string;
  calliopeMiniVersion: string;
  /** e.g. `(v) => \`Calliope mini ${v}\`` */
  calliopeMiniVersionLabel: (version: number) => string;

  // Share modal
  shareModalTitle: string;
  shareCreatingLink: string;
  shareIntroBefore: string;
  shareIntroAfter: string;
  shareThisProgram: string;
  shareLinkAria: string;
  shareCopyLink: string;
  shareLinkCopied: string;
  shareCopyFailed: string;
  shareQrAlt: string;
  shareClose: string;
  shareOpen: string;
  shareEditorNotReady: string;
  shareNoProgram: string;
  shareFailed: string;
}

export const DEFAULT_MAKECODE_LABELS: MakeCodeLabels = {
  programmingMode: 'Programmiermodus',
  modeBlocks: 'Blöcke',
  modeJavaScript: 'JavaScript',
  modePython: 'Python',

  share: 'Teilen',
  shareProgram: 'Programm teilen',
  sharingInProgress: 'Wird geteilt…',
  extensions: 'Erweiterungen',
  extensionsCount: (count) => (count === 1 ? '1 Erweiterung' : `${count} Erweiterungen`),
  noExtensionsAdded: 'Keine Erweiterungen hinzugefügt',
  openOnGithub: 'Auf GitHub öffnen',
  removeExtension: 'Erweiterung entfernen',
  calliopeMiniVersion: 'Calliope mini Version',
  calliopeMiniVersionLabel: (version) => `Calliope mini ${version}`,

  shareModalTitle: 'Programm teilen',
  shareCreatingLink: 'Link wird erstellt…',
  shareIntroBefore: 'Jeder mit diesem Link kann ',
  shareIntroAfter: ' öffnen und kopieren.',
  shareThisProgram: 'dieses Programm',
  shareLinkAria: 'Link zum Programm',
  shareCopyLink: 'Link kopieren',
  shareLinkCopied: 'Link kopiert',
  shareCopyFailed: 'Kopieren fehlgeschlagen',
  shareQrAlt: 'QR-Code zum Programm',
  shareClose: 'Schließen',
  shareOpen: 'Öffnen',
  shareEditorNotReady: 'Der Editor ist noch nicht bereit. Versuche es in einem Moment erneut.',
  shareNoProgram: 'Kein Programm zum Teilen gefunden.',
  shareFailed: 'Der Link konnte nicht erstellt werden. Versuche es später erneut.',
};

export function mergeMakeCodeLabels(overrides?: Partial<MakeCodeLabels>): MakeCodeLabels {
  if (!overrides) return DEFAULT_MAKECODE_LABELS;
  return { ...DEFAULT_MAKECODE_LABELS, ...overrides };
}
