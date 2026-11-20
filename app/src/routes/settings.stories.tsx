import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { type BucketFixture, bucketServer, MIXED_BUCKETS } from '@/components/domain/bucket-fixtures';
import { AppLayout } from '@/components/layouts/app-layout';
import { clientId } from '@/lib/id';
import { ROUTES } from '@/lib/routes';
import { SettingsRoute, settingsLink } from './settings';

/**
 * The settings screen against a mock server built from the real SDL.
 *
 * This is the `resolvers` half of the Apollo parameter rather than a list of canned responses,
 * and the difference matters here: every answer is executed against the schema `server/` prints
 * from its own Drizzle models. A field that gets renamed there, or a scalar that changes shape,
 * fails these stories — where a hand-written `MockedProvider` response would happily keep
 * serving the old shape forever.
 */

/** The page at one tab, as a link to it would open it. */
function at(tab: string) {
  return { initialEntries: [`${ROUTES.settings}?tab=${tab}`] };
}

const RESOLVERS = {
  Query: {
    ...bucketServer([]).resolvers.Query,
    me: () => ({ id: '9c1f0a6e-5d33-4f1b-8e27-0a9b8c7d6e5f', email: 'owner@example.com' }),
    ssoSetup: () => ({
      source: 'NONE',
      issuer: null,
      name: null,
      canPair: true,
      redirectUri: 'http://localhost:3005/sso/oidc/callback',
    }),
    authConfig: () => ({ sso: null }),
    apiKeys: () => [],
  },
};

/** The page's server, with buckets that its bucket mutations really change. */
function withBuckets(buckets: readonly BucketFixture[]) {
  const { resolvers } = bucketServer(buckets);
  return { Query: { ...RESOLVERS.Query, ...resolvers.Query }, Mutation: resolvers.Mutation };
}

/** A key as `apiKeys` answers it. */
interface ApiKeyFixture {
  id: string;
  name: string;
  start: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

const CLAUDE_CODE_KEY: ApiKeyFixture = {
  id: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
  name: 'Claude Code on my laptop',
  start: 's3a_Ab12Cd34',
  lastUsedAt: '2026-10-20T08:00:00.000Z',
  expiresAt: null,
  createdAt: '2026-10-01T09:00:00.000Z',
};

/** A server whose keys can be made and revoked, so a story sees the list change. */
function keyServer(start: ApiKeyFixture[]) {
  const keys = [...start];
  return {
    Query: { ...RESOLVERS.Query, apiKeys: () => keys },
    Mutation: {
      createApiKey: (_parent: unknown, args: { name: string }) => {
        const apiKey = { ...CLAUDE_CODE_KEY, id: clientId(), name: args.name, lastUsedAt: null };
        keys.unshift(apiKey);
        return { apiKey, key: 's3a_Ab12Cd34TheRestOfTheSecretKey' };
      },
      revokeApiKey: (_parent: unknown, args: { id: string }) => {
        keys.splice(
          keys.findIndex((key) => key.id === args.id),
          1,
        );
        return true;
      },
    },
  };
}

/** Bounded height, because `PageLayout` is a sticky chassis that scrolls its own body. */
function Framed() {
  return (
    <div className="h-screen">
      <SettingsRoute />
    </div>
  );
}

const meta = {
  title: 'Routes/Settings',
  component: SettingsRoute,
  render: () => <Framed />,
  parameters: {
    layout: 'fullscreen',
    router: { initialEntries: [ROUTES.settings] },
    apolloClient: { resolvers: RESOLVERS },
  },
} satisfies Meta<typeof SettingsRoute>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The first tab, which is where the page opens: the buckets, and adding the first one. */
export const Ready: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole('heading', { name: 'Buckets' })).toBeInTheDocument();
    await expect(canvas.getByRole('tab', { name: 'Buckets' })).toHaveAttribute('aria-selected', 'true');
    await expect(canvas.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Buckets',
      'Auth',
      'API keys',
      'Appearance',
    ]);
    await expect(await canvas.findByText(/No buckets yet/)).toBeInTheDocument();
    // The theme has its own tab, not a place in the header.
    await expect(canvas.queryByRole('radiogroup', { name: 'Theme' })).not.toBeInTheDocument();
  },
};

/** The Auth tab: the account, and the sign-in provider form. */
export const Auth: Story = {
  parameters: { router: at('auth') },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText('owner@example.com')).toBeInTheDocument();
    await expect(canvas.getByRole('tab', { name: 'Auth' })).toHaveAttribute('aria-selected', 'true');
    await expect(await canvas.findByRole('heading', { name: 'Sign-in' })).toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: /setup url/i })).toBeInTheDocument();
  },
};

/** Buckets on several providers and accounts. */
export const Buckets: Story = {
  parameters: { apolloClient: { resolvers: withBuckets(MIXED_BUCKETS) } },
  play: async ({ canvas }) => {
    const list = within(await canvas.findByRole('list', { name: 'Buckets' }));
    await expect(list.getAllByRole('listitem')).toHaveLength(MIXED_BUCKETS.length);
    await expect(list.getByText('AWS S3 · eu-west-1 · acme-reports')).toBeInTheDocument();
  },
};

/** Adding the first bucket from the empty tab: the dialog, then the bucket in the list. */
export const AddsABucket: Story = {
  parameters: { apolloClient: { resolvers: withBuckets([]) } },
  play: async ({ canvas, canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Add bucket' }));
    const dialog = within(await page.findByRole('dialog', { name: 'Add a bucket' }));
    await userEvent.type(dialog.getByRole('textbox', { name: /Name/ }), 'Reports');
    await userEvent.type(dialog.getByRole('textbox', { name: /Region/ }), 'eu-west-1');
    await userEvent.type(dialog.getByRole('textbox', { name: /^Bucket/ }), 'acme-reports');
    await userEvent.type(dialog.getByRole('textbox', { name: /Access key ID/ }), 'AKIAIOSFODNN7EXAMPLE');
    await userEvent.type(dialog.getByLabelText(/^Secret access key/), 'wJalrXUtnFEMI/K7MDENG');
    await userEvent.click(dialog.getByRole('button', { name: 'Add bucket' }));
    await waitFor(() => expect(page.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(await canvas.findByText('Reports')).toBeInTheDocument();
  },
};

/** A tab is a link: pressing one opens it, and the URL carries it, so a reload lands there too. */
export const SwitchesTabs: Story = {
  play: async ({ canvas }) => {
    await canvas.findByRole('heading', { name: 'Buckets' });
    await expect(canvas.getByRole('tab', { name: 'Buckets' })).toHaveAttribute('href', settingsLink('buckets'));
    await expect(canvas.getByRole('tab', { name: 'Auth' })).toHaveAttribute('href', '/settings?tab=auth');
    const keys = canvas.getByRole('tab', { name: 'API keys' });
    await expect(keys).toHaveAttribute('href', '/settings?tab=api-keys');
    await userEvent.click(keys);
    await expect(await canvas.findByRole('heading', { name: 'API keys' })).toBeInTheDocument();
    await expect(canvas.queryByRole('heading', { name: 'Buckets' })).not.toBeInTheDocument();
  },
};

/** A tab that does not exist opens the first, rather than an empty page. */
export const UnknownTab: Story = {
  parameters: { router: at('nonsense') },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole('heading', { name: 'Buckets' })).toBeInTheDocument();
    await expect(canvas.getByRole('tab', { name: 'Buckets' })).toHaveAttribute('aria-selected', 'true');
  },
};

/** Before the answer lands. The skeleton stands in for the cards rather than the page being blank. */
export const Loading: Story = {
  parameters: { apolloClient: { resolvers: RESOLVERS, delay: 100_000 } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveAccessibleName('Loading');
    await expect(canvas.queryByRole('heading', { name: 'Buckets' })).not.toBeInTheDocument();
  },
};

/**
 * The server answered with an error. A page that renders a failure as an absence tells someone
 * whose server has gone away that they have no settings, so the rung has to be its own state
 * with the reason and a way to ask again.
 */
export const Unreachable: Story = {
  parameters: {
    apolloClient: {
      resolvers: {
        Query: {
          ...RESOLVERS.Query,
          me: () => {
            throw new Error('Unauthenticated');
          },
        },
      },
    },
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Could not load your settings');
    await expect(canvas.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  },
};

/** No keys yet: the card says what one is for. */
export const NoKeys: Story = {
  parameters: { router: at('api-keys') },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/No keys yet/)).toBeInTheDocument();
  },
};

/** The keys MCP clients connect with, none shown whole. */
export const Keys: Story = {
  parameters: { router: at('api-keys'), apolloClient: { resolvers: keyServer([CLAUDE_CODE_KEY]) } },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText('Claude Code on my laptop')).toBeInTheDocument();
    await expect(canvas.getByText('s3a_Ab12Cd34…')).toBeInTheDocument();
    await expect(canvas.getByText(/Never expires/)).toBeInTheDocument();
  },
};

/** A new key is shown once, then listed by its start alone. */
export const MakesAKey: Story = {
  parameters: { router: at('api-keys'), apolloClient: { resolvers: keyServer([]) } },
  play: async ({ canvas, canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(await canvas.findByText(/No keys yet/)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'New key' }));

    const form = within(await page.findByRole('dialog', { name: 'New API key' }));
    await userEvent.type(form.getByRole('textbox', { name: /Name/ }), 'Claude Desktop');
    await userEvent.click(form.getByRole('button', { name: 'Make key' }));

    const shown = within(await page.findByRole('dialog', { name: 'Your new API key' }));
    await expect(shown.getAllByText(/s3a_Ab12Cd34TheRestOfTheSecretKey/).length).toBeGreaterThan(0);
    await expect(shown.getByRole('button', { name: 'Copy API key' })).toBeInTheDocument();
    await userEvent.click(shown.getByRole('button', { name: 'Done' }));

    await expect(await canvas.findByText('Claude Desktop')).toBeInTheDocument();
    await expect(canvas.queryByText(/TheRestOfTheSecretKey/)).not.toBeInTheDocument();
  },
};

/** Revoking asks first, saying what stops working, and the key leaves the list. */
export const RevokesAKey: Story = {
  parameters: { router: at('api-keys'), apolloClient: { resolvers: keyServer([CLAUDE_CODE_KEY]) } },
  play: async ({ canvas, canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Revoke' }));
    const dialog = within(await page.findByRole('alertdialog'));
    await expect(dialog.getByText(/refused from its next call/)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(canvas.queryByText('Claude Code on my laptop')).not.toBeInTheDocument());
  },
};

/** The Appearance tab: the theme as three tiles, and picking one checks it. */
export const Appearance: Story = {
  parameters: { router: at('appearance') },
  play: async ({ canvas }) => {
    const theme = await canvas.findByRole('radiogroup', { name: 'Theme' });
    await expect(theme).toBeVisible();
    const dark = canvas.getByRole('radio', { name: /Dark/ });
    await userEvent.click(dark);
    await expect(dark).toBeChecked();
  },
};

/** Phone width, on Buckets: four tabs and a mixed list fit, and nothing pushes the page sideways. */
export const NarrowBuckets: Story = {
  globals: { viewport: { value: 'mobile1' } },
  parameters: { apolloClient: { resolvers: withBuckets(MIXED_BUCKETS) } },
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByRole('list', { name: 'Buckets' })).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};

/** Phone width: the header, its tabs and the theme tiles fit, and nothing pushes the page sideways. */
export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
  parameters: { router: at('appearance') },
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByRole('radiogroup', { name: 'Theme' })).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};

const shell = bucketServer(MIXED_BUCKETS);
/**
 * Settings in its shell: removing a bucket here takes it out of the sidebar's tree too, without
 * a reload, because the tree reads buckets through its own query.
 */
export const RemovingABucketUpdatesTheTree: Story = {
  parameters: {
    router: at('buckets'),
    apolloClient: {
      resolvers: {
        Query: { ...RESOLVERS.Query, ...shell.resolvers.Query },
        Mutation: shell.resolvers.Mutation,
        Bucket: { documents: () => [] },
      },
    },
  },
  render: () => <AppLayout contentSlot={<SettingsRoute />} />,
  play: async ({ canvas, canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const tree = within(await canvas.findByRole('list', { name: 'Buckets and documents' }));
    await expect(await tree.findByRole('button', { name: /^Scratch/ })).toBeInTheDocument();

    const main = within(canvas.getByRole('main'));
    await userEvent.click(await main.findByRole('button', { name: 'More for Scratch' }));
    await userEvent.click(await page.findByRole('menuitem', { name: 'Remove' }));
    await userEvent.click(within(await page.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(tree.queryByRole('button', { name: /^Scratch/ })).not.toBeInTheDocument());
    const left = within(await canvas.findByRole('list', { name: 'Buckets and documents' }));
    await expect(await left.findByRole('button', { name: /^Artifacts/ })).toBeInTheDocument();
  },
};
