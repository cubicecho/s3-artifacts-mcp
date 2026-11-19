import { useQuery } from '@apollo/client/react';
import { Link, useSearchParams } from 'react-router';
import { graphql } from '@/__generated__';
import { CardLayout } from '@/components/card-layout';
import { ApiKeySettings } from '@/components/domain/api-key-settings';
import { LogOut } from '@/components/domain/app-icons';
import { SsoSettings } from '@/components/domain/sso-pairing';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Button } from '@/components/ui/button';
import { Settings } from '@/components/ui/icons';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ThemePicker } from '@/components/ui/theme-picker';
import { FULL_WIDTH_BODY } from '@/lib/page';
import { queryLike } from '@/lib/query';
import { useSignOut } from '@/lib/sign-out';
import { cn } from '@/lib/utils';

const SettingsPage = graphql(`
  query SettingsPage {
    me {
      id
      email
    }
  }
`);

/** The query-string key that holds the open tab, so a tab can be linked and survives a reload. */
export const SETTINGS_TAB_PARAM = 'tab';

/** The tabs, in order. The first is where an absent or unknown `?tab=` lands. */
export const SETTINGS_TABS = [
  { value: 'sign-in', label: 'Sign-in' },
  { value: 'api-keys', label: 'API keys' },
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
 * The link a tab is: this page, with only the tab in its query string.
 *
 * @param tab - The tab to link to.
 * @returns The search part of the link, empty for the first tab.
 */
function tabSearch(tab: SettingsTab): string {
  return tab === SETTINGS_TABS[0].value ? '' : `?${new URLSearchParams({ [SETTINGS_TAB_PARAM]: tab })}`;
}

/**
 * The owner's settings, a tab each: how they sign in, and the API keys MCP clients use. The theme
 * is in the header, on every tab. The open tab is in the URL (`?tab=api-keys`).
 *
 * @returns The settings page.
 */
export function SettingsRoute() {
  const signOut = useSignOut();
  const result = useQuery(SettingsPage);
  const { data } = result;
  const [params] = useSearchParams();
  const tab = settingsTabOf(params.get(SETTINGS_TAB_PARAM));

  return (
    <Tabs value={tab} className="h-full">
      <PageLayout
        iconSlot={<Settings />}
        title="Settings"
        description="How you sign in, and the keys MCP clients use."
        width="full"
        actionSlot={<ThemePicker variant="compact" />}
        headerContentSlot={
          <TabsList aria-label="Settings">
            {SETTINGS_TABS.map((entry) => (
              <TabsTrigger
                key={entry.value}
                value={entry.value}
                linkSlot={<Link to={{ search: tabSearch(entry.value) }} replace />}
              >
                {entry.label}
              </TabsTrigger>
            ))}
          </TabsList>
        }
        contentClassName={cn(FULL_WIDTH_BODY, 'gap-6')}
        contentSlot={
          <>
            {/* Inside the open tab's panel, so the tab names the region that is loading or failed. */}
            {data ? null : (
              <TabsContent value={tab}>
                <LoadState query={queryLike(result)} what="your settings" count={0} />
              </TabsContent>
            )}

            {data && (
              <>
                <TabsContent value="sign-in" className="flex flex-col gap-6">
                  <CardLayout
                    level={2}
                    title="Account"
                    description="You own this instance. Signing out forgets this browser's session; signing back in needs only your address."
                    contentSlot={<PropertyList contentSlot={<PropertyRow label="Email" value={data.me.email} />} />}
                    footerActionsSlot={
                      <Button variant="outline" iconSlot={<LogOut />} content="Sign out" onClick={signOut} />
                    }
                  />
                  <SsoSettings />
                </TabsContent>

                <TabsContent value="api-keys" className="flex flex-col gap-6">
                  <ApiKeySettings />
                </TabsContent>
              </>
            )}
          </>
        }
      />
    </Tabs>
  );
}
