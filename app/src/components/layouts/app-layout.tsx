import { useLinkClickHandler, useMatch } from 'react-router';
import { LogOut } from '@/components/domain/app-icons';
import { BucketSidebarSection } from '@/components/domain/bucket-sidebar';
import { AppBarItem, Sidebar, SidebarItem, SidebarSection } from '@/components/sidebar';
import { SidebarLayout } from '@/components/split-layout';
import { Button } from '@/components/ui/button';
import { FileText, type IconProps, Settings, Tag } from '@/components/ui/icons';
import { APP_NAME } from '@/consts';
import { ROUTES } from '@/lib/routes';
import { useSignOut } from '@/lib/sign-out';
import type { SlotNode } from '@/lib/utils';

type NavItem = {
  to: string;
  label: string;
  icon: React.ComponentType<IconProps>;
  end: boolean;
  /** Where the sidebar draws it: with the places, or at the foot with sign-out, as cubeui apps put Settings. */
  placement: 'main' | 'footer';
};

const NAV_ITEMS: readonly NavItem[] = [
  // `end` so "Documents" is not also marked active on a page below it.
  { to: ROUTES.documents, label: 'Documents', icon: FileText, end: true, placement: 'main' },
  { to: ROUTES.tags, label: 'Tags', icon: Tag, end: false, placement: 'main' },
  { to: ROUTES.settings, label: 'Settings', icon: Settings, end: false, placement: 'footer' },
];

const MAIN_ITEMS = NAV_ITEMS.filter((item) => item.placement === 'main');
const FOOTER_ITEMS = NAV_ITEMS.filter((item) => item.placement === 'footer');

/**
 * react-router hands out a click handler rather than a link to wrap the row in,
 * so the row keeps its own `href` and takes the handler beside it.
 */
function useNavLink({ to, end }: NavItem) {
  const onClick = useLinkClickHandler<HTMLButtonElement>(to);
  const active = useMatch({ path: to, end }) !== null;
  return { href: to, onClick, active };
}

/** One row of the nav. */
interface NavLinkProps {
  item: NavItem;
}

/**
 * A place in the sidebar.
 *
 * @param props - The place.
 * @returns The sidebar row.
 */
function RailLink({ item }: NavLinkProps) {
  const Icon = item.icon;
  return <SidebarItem {...useNavLink(item)} label={item.label} iconSlot={<Icon />} />;
}

/**
 * The same place, as an icon in the phone's bar.
 *
 * @param props - The place.
 * @returns The bar item.
 */
function BarLink({ item }: NavLinkProps) {
  const Icon = item.icon;
  return <AppBarItem {...useNavLink(item)} label={item.label} iconSlot={<Icon />} />;
}

function Brand() {
  return (
    <div className="flex items-center gap-2 px-2 py-1 font-semibold text-foreground">
      <FileText className="size-5" aria-hidden />
      <span>{APP_NAME}</span>
    </div>
  );
}

interface AppLayoutProps {
  /** The page to draw beside the sidebar. It is given a real height to scroll within. */
  contentSlot: SlotNode;
}

/**
 * The shell around every signed-in page: cubeui's `Sidebar` on the left, the
 * page on the right, and under `md` a bar over the page in the sidebar's place.
 *
 * This owns what `PageLayout` deliberately does not: the navigation, the bucket
 * tree and signing out. Pages own their own headers and keep using
 * `PageLayout` inside this.
 */
export function AppLayout({ contentSlot }: AppLayoutProps) {
  const signOut = useSignOut();

  return (
    // `h-svh`, not `min-h-svh`: PageLayout is a sticky chassis that scrolls its
    // own body, and it can only do that if something above it has a real height
    // to measure against.
    <SidebarLayout
      className="h-svh"
      sidebarPosition="start"
      sidebarWidth="auto"
      sidebarHideBelow="md"
      divider="none"
      sidebarSlot={
        <Sidebar
          // Wider than the rail's default, for the bucket tree's names.
          className="w-80"
          headerSlot={<Brand />}
          contentSlot={
            <>
              <SidebarSection
                as="nav"
                label="Main"
                contentSlot={MAIN_ITEMS.map((item) => <RailLink key={item.to} item={item} />)}
              />
              <BucketSidebarSection />
            </>
          }
          footerSlot={
            <>
              {FOOTER_ITEMS.map((item) => (
                <RailLink key={item.to} item={item} />
              ))}
              <SidebarItem label="Sign out" iconSlot={<LogOut />} onClick={signOut} />
            </>
          }
        />
      }
      navLabel="Main"
      // The bar has no foot, so every place is an icon in it, Settings included.
      navSlot={NAV_ITEMS.map((item) => <BarLink key={item.to} item={item} />)}
      // The theme is chosen on Settings → Appearance, not in the bar or the sidebar.
      actionSlot={
        <Button aria-label="Sign out" variant="outline" size="icon-sm" iconSlot={<LogOut />} onClick={signOut} />
      }
      contentSlot={<main className="flex min-h-0 min-w-0 flex-1 flex-col">{contentSlot}</main>}
    />
  );
}
