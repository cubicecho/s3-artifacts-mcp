import type { Meta, StoryObj } from '@storybook/react-vite';
import { GraphQLError } from 'graphql';
import { Route, Routes } from 'react-router';
import { expect, fn, waitFor } from 'storybook/test';
import { clearToken, getToken, setToken } from '@/lib/auth';
import { ROUTES } from '@/lib/routes';
import { SettingsRoute } from '@/routes/settings';
import { RequireAuth } from './require-auth';

/**
 * The gate in front of every signed-in page: no token is the sign-in page, a token is the page
 * inside the shell, and a server that says the session is over takes the token away.
 *
 * The page behind the gate is Settings, the one page that asks the server for something at
 * step 1. The last story runs the app's own session link (`sessionOverLink`), which every `resolvers`
 * story's client has in front of its mock server. Where the app reloads into sign-in, the story
 * records the call instead, since a reload would take the story with it.
 */

const TOKEN = 'a-session-token';

/** Where the app would reload into sign-in. */
const sessionOver = fn();

function Framed() {
  return (
    <div className="h-screen">
      <Routes>
        <Route path={ROUTES.login} element={<h1>The sign-in page</h1>} />
        <Route path={ROUTES.documents} element={<RequireAuth contentSlot={<SettingsRoute />} />} />
      </Routes>
    </div>
  );
}

const OWNER = { id: '9c1f0a6e-5d33-4f1b-8e27-0a9b8c7d6e5f', email: 'owner@example.com' };
const NOTHING_PAIRED = {
  source: 'NONE',
  issuer: null,
  name: null,
  canPair: true,
  redirectUri: 'http://localhost:3005/sso/oidc/callback',
};
const SERVER = { Query: { me: () => OWNER, ssoSetup: () => NOTHING_PAIRED } };

const meta = {
  title: 'Layouts/RequireAuth',
  component: RequireAuth,
  render: () => <Framed />,
  args: { contentSlot: null },
  parameters: {
    layout: 'fullscreen',
    router: { initialEntries: [ROUTES.documents] },
    apolloClient: { resolvers: SERVER, onSessionOver: sessionOver },
  },
  beforeEach: () => {
    sessionOver.mockClear();
    // Everything a story leaves in storage is there for the next file.
    return () => clearToken();
  },
} satisfies Meta<typeof RequireAuth>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No token: straight to sign-in, without the shell and without asking the server anything. */
export const SignedOut: Story = {
  beforeEach: () => clearToken(),
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole('heading', { level: 1, name: 'The sign-in page' })).toBeInTheDocument();
    await expect(canvas.queryByRole('navigation')).not.toBeInTheDocument();
    await expect(canvas.queryByText('owner@example.com')).not.toBeInTheDocument();
  },
};

/** A token: the page, inside the shell with its sidebar. */
export const SignedIn: Story = {
  beforeEach: () => setToken(TOKEN),
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    await expect(await canvas.findByText('owner@example.com')).toBeInTheDocument();
    await expect(canvas.getAllByRole('link', { name: 'Documents' }).length).toBeGreaterThan(0);
    await expect(sessionOver).not.toHaveBeenCalled();
    await expect(getToken()).toBe(TOKEN);
  },
};

/** The server no longer knows the session: the token is dropped and the app goes to sign-in. */
export const SessionOver: Story = {
  beforeEach: () => setToken(TOKEN),
  parameters: {
    apolloClient: {
      onSessionOver: sessionOver,
      resolvers: {
        Query: {
          ...SERVER.Query,
          me: () => {
            throw new GraphQLError('Sign in again', { extensions: { code: 'UNAUTHENTICATED' } });
          },
        },
      },
    },
  },
  play: async () => {
    await waitFor(() => expect(sessionOver).toHaveBeenCalled());
    await expect(getToken()).toBeNull();
  },
};
