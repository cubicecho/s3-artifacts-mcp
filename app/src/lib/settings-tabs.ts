import { ROUTES } from '@/lib/routes';

// Settings' tabs, which live in the query string (`?tab=`) so a tab can be linked and survives a reload. Here rather
// than in the route, so a component the route renders can link to another tab without importing the route.

/** The query-string key that holds the open tab, so a tab can be linked and survives a reload. */
export const SETTINGS_TAB_PARAM = 'tab';

/** The tabs, in order. The first is where an absent or unknown `?tab=` lands. */
export const SETTINGS_TABS = [
  { value: 'buckets', label: 'Buckets' },
  { value: 'share-links', label: 'Share links' },
  { value: 'mcp', label: 'MCP' },
  { value: 'general', label: 'General' },
  { value: 'auth', label: 'Auth' },
  { value: 'api-keys', label: 'API keys' },
  { value: 'appearance', label: 'Appearance' },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]['value'];

/**
 * The tab `?tab=` names, or the first when it names none.
 *
 * @param requested - The query string's `tab`, if any.
 * @returns The tab to open.
 */
export function settingsTabOf(requested: string | null): SettingsTab {
  return SETTINGS_TABS.find((entry) => entry.value === requested)?.value ?? SETTINGS_TABS[0].value;
}

/**
 * The link a tab is: the settings page, with only the tab in its query string.
 *
 * @param tab - The tab to link to.
 * @returns The search part of the link, empty for the first tab.
 */
export function tabSearch(tab: SettingsTab): string {
  return tab === SETTINGS_TABS[0].value ? '' : `?${new URLSearchParams({ [SETTINGS_TAB_PARAM]: tab })}`;
}

/**
 * A link to one tab of the settings page, for a page elsewhere that sends the reader here.
 *
 * @param tab - The tab to open.
 * @returns The path and query string.
 */
export function settingsLink(tab: SettingsTab): string {
  return `${ROUTES.settings}${tabSearch(tab)}`;
}
