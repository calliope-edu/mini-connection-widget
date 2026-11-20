/**
 * Stand-ins for @calliope-edu/ui under the Node test runner (see ui-stub-resolve.mjs).
 *
 * The widget's UI tests server-render its components and assert on the words
 * they show, in German and in English. calliope-ui's Dialog and Popover render
 * through a portal that is empty on the server, and the library ships
 * TypeScript and CSS Node can't load from node_modules, so the tests get these
 * plain components instead: each renders the texts it is given (title,
 * labels, children, accessible names) and nothing else. How the real
 * components look and behave is calliope-ui's to test.
 */
export { default as Dialog } from './Dialog.svelte';
export { default as Button } from './Button.svelte';
export { default as IconButton } from './IconButton.svelte';
export { default as ChoiceList } from './ChoiceList.svelte';
export { default as ChoiceItem } from './ChoiceItem.svelte';
export { default as Icon } from './Icon.svelte';
export { default as Spinner } from './Spinner.svelte';
export { default as ProgressBar } from './ProgressBar.svelte';
export { default as StatusDot } from './StatusDot.svelte';
export { default as Badge } from './Badge.svelte';
export { default as Popover } from './Popover.svelte';
export { default as Tabs } from './Passthrough.svelte';
export { default as TabList } from './Passthrough.svelte';
export { default as TabPanel } from './Passthrough.svelte';
export { default as Menu } from './Passthrough.svelte';
export { default as MenuRadioGroup } from './Passthrough.svelte';
export { default as Tab } from './Tab.svelte';
export { default as TextField } from './Leaf.svelte';
export { default as SegmentedControl } from './Leaf.svelte';
export { default as MenuRadioItem } from './Leaf.svelte';
