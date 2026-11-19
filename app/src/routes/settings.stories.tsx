import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { clientId } from '@/lib/id';
import { ROUTES } from '@/lib/routes';
import { SettingsRoute } from './settings';

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

/** The first tab, which is where the page opens: the account, and the sign-in provider form. */
export const Ready: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByText('owner@example.com')).toBeInTheDocument();
    await expect(canvas.getByRole('tab', { name: 'Sign-in' })).toHaveAttribute('aria-selected', 'true');
    await expect(canvas.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Sign-in', 'API keys']);
    await expect(await canvas.findByRole('heading', { name: 'Sign-in' })).toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: /setup url/i })).toBeInTheDocument();
    // A device preference, in the header on every tab.
    await expect(canvas.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
  },
};

/** A tab is a link: pressing one opens it, and the URL carries it, so a reload lands there too. */
export const SwitchesTabs: Story = {
  play: async ({ canvas }) => {
    await canvas.findByText('owner@example.com');
    const keys = canvas.getByRole('tab', { name: 'API keys' });
    await expect(keys).toHaveAttribute('href', '/settings?tab=api-keys');
    await userEvent.click(keys);
    await expect(await canvas.findByRole('heading', { name: 'API keys' })).toBeInTheDocument();
    await expect(canvas.queryByText('owner@example.com')).not.toBeInTheDocument();
  },
};

/** A tab that does not exist opens the first, rather than an empty page. */
export const UnknownTab: Story = {
  parameters: { router: at('nonsense') },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText('owner@example.com')).toBeInTheDocument();
    await expect(canvas.getByRole('tab', { name: 'Sign-in' })).toHaveAttribute('aria-selected', 'true');
  },
};

/** Before the answer lands. The skeleton stands in for the cards rather than the page being blank. */
export const Loading: Story = {
  parameters: { apolloClient: { resolvers: RESOLVERS, delay: 100_000 } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveAccessibleName('Loading');
    await expect(canvas.queryByText('owner@example.com')).not.toBeInTheDocument();
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

/** Phone width: the header, its tabs and the theme fit, and nothing pushes the page sideways. */
export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByText('owner@example.com')).toBeInTheDocument();
    await expect(canvas.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
