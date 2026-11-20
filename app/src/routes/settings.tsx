import { useQuery } from '@apollo/client/react';
import { Link, useSearchParams } from 'react-router';
import { graphql } from '@/__generated__';
import { CardLayout } from '@/components/card-layout';
import { ApiKeySettings } from '@/components/domain/api-key-settings';
import { LogOut } from '@/components/domain/app-icons';
import { BucketSettings } from '@/components/domain/bucket-settings';
import { GeneralSettings } from '@/components/domain/general-settings';
import { ShareLinkSettings } from '@/components/domain/share-link-settings';
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
import { SETTINGS_TAB_PARAM, SETTINGS_TABS, settingsTabOf, tabSearch } from '@/lib/settings-tabs';
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

/**
 * The owner's settings, a tab each: the buckets documents are stored in, every share link, the
 * upload limit and link defaults, how they sign in, the API keys MCP clients use, and how the app
 * looks on this device. The open tab is in the URL
 * (`?tab=api-keys`); Buckets is first, so `/settings` opens there.
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
        description="Where documents are stored, how they are shared, how you sign in, the keys MCP clients use, and how this looks."
        width="full"
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
                <TabsContent value="buckets" className="flex flex-col gap-6">
                  <BucketSettings />
                </TabsContent>

                <TabsContent value="share-links" className="flex flex-col gap-6">
                  <ShareLinkSettings />
                </TabsContent>

                <TabsContent value="general" className="flex flex-col gap-6">
                  <GeneralSettings />
                </TabsContent>

                <TabsContent value="auth" className="flex flex-col gap-6">
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

                <TabsContent value="appearance" className="flex flex-col gap-6">
                  <CardLayout
                    level={2}
                    title="Theme"
                    description="Light, dark, or whatever this device is set to. Kept in this browser only."
                    contentSlot={<ThemePicker />}
                  />
                </TabsContent>
              </>
            )}
          </>
        }
      />
    </Tabs>
  );
}
