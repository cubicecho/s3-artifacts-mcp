import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { claudeMcpAddCommand, mcpEndpoint } from '@/lib/mcp';
import { settingsLink } from '@/lib/settings-tabs';
import { type BucketFixture, bucketServer, MINIO_BUCKET, S3_BUCKET } from './bucket-fixtures';
import { McpSettings } from './mcp-settings';

/**
 * Settings' MCP tab against a mock server built from the real SDL: per bucket, whether an agent may reach it and
 * write to it, its endpoint, and the command that connects Claude Code.
 */

/** A bucket agents may read. */
const READABLE: BucketFixture = { ...MINIO_BUCKET, mcpEnabled: true };
/** A bucket agents may read and write. */
const WRITABLE: BucketFixture = { ...S3_BUCKET, mcpEnabled: true, mcpWritable: true };

/**
 * A story's server.
 *
 * @param buckets - What it holds.
 * @param [options] - How `setBucketMcp` answers.
 * @returns The story's parameters, and the server to inspect in `play`.
 */
function served(buckets: readonly BucketFixture[], options: Parameters<typeof bucketServer>[1] = {}) {
  const server = bucketServer(buckets, options);
  return { server, parameters: { apolloClient: { resolvers: server.resolvers } } };
}

const meta = {
  title: 'Domain/McpSettings',
  component: McpSettings,
  parameters: served([MINIO_BUCKET, S3_BUCKET]).parameters,
} satisfies Meta<typeof McpSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One bucket's section, by its name. */
const sectionOf = async (canvas: ReturnType<typeof within>, name: string) =>
  within(await canvas.findByRole('region', { name }));

/** The two switches in a bucket's section. */
function switchesOf(section: ReturnType<typeof within>) {
  return {
    reachable: section.getByRole('switch', { name: 'Reachable over MCP' }),
    writable: section.getByRole('switch', { name: 'Writable' }),
  };
}

/** Every bucket off, as a new bucket is: no endpoint is shown, and Writable waits for Reachable. */
export const AllOff: Story = {
  play: async ({ canvas }) => {
    const artifacts = await sectionOf(canvas, 'Artifacts');
    const { reachable, writable } = switchesOf(artifacts);
    await expect(reachable).not.toBeChecked();
    await expect(writable).not.toBeChecked();
    await expect(writable).toHaveAttribute('aria-disabled', 'true');
    await expect(artifacts.queryByText('Endpoint')).not.toBeInTheDocument();
    await expect(canvas.getByRole('link', { name: 'Manage API keys' })).toHaveAttribute(
      'href',
      settingsLink('api-keys'),
    );
  },
};

/** A reachable bucket shows its endpoint and the Claude Code command, each with a copy button. */
export const Reachable: Story = {
  parameters: served([READABLE, WRITABLE]).parameters,
  play: async ({ canvas }) => {
    const endpoint = mcpEndpoint(window.location.origin, READABLE.slug);
    const artifacts = await sectionOf(canvas, 'Artifacts');
    await expect(switchesOf(artifacts).reachable).toBeChecked();
    await expect(switchesOf(artifacts).writable).not.toBeChecked();
    await expect(artifacts.getByText(endpoint)).toBeInTheDocument();
    await expect(artifacts.getByText(claudeMcpAddCommand(READABLE.slug, endpoint))).toBeInTheDocument();
    await expect(artifacts.getByRole('button', { name: 'Copy the endpoint of Artifacts' })).toBeInTheDocument();
    await expect(
      artifacts.getByRole('button', { name: 'Copy the Claude Code command for Artifacts' }),
    ).toBeInTheDocument();

    const reports = await sectionOf(canvas, 'Reports');
    await expect(switchesOf(reports).writable).toBeChecked();
    await expect(reports.getByText(/--transport http reports .*\/mcp\/b\/reports --header "x-api-key: /)).toBeVisible();
  },
};

const toggling = served([MINIO_BUCKET]);
/** Turning a bucket on, then writable, then off again: off takes writable with it, as the server requires. */
export const Toggles: Story = {
  parameters: toggling.parameters,
  play: async ({ canvas }) => {
    const artifacts = await sectionOf(canvas, 'Artifacts');
    await userEvent.click(switchesOf(artifacts).reachable);
    await waitFor(() => expect(switchesOf(artifacts).reachable).toBeChecked());
    await expect(await artifacts.findByText('Endpoint')).toBeInTheDocument();
    await waitFor(() => expect(switchesOf(artifacts).writable).not.toHaveAttribute('aria-disabled', 'true'));
    await userEvent.click(switchesOf(artifacts).writable);
    await waitFor(() => expect(switchesOf(artifacts).writable).toBeChecked());
    await userEvent.click(switchesOf(artifacts).reachable);
    await waitFor(() => expect(switchesOf(artifacts).reachable).not.toBeChecked());
    await expect(switchesOf(artifacts).writable).not.toBeChecked();
    await expect(artifacts.queryByText('Endpoint')).not.toBeInTheDocument();

    const id = MINIO_BUCKET.id;
    await expect(toggling.server.mcpCalls).toEqual([
      { id, enabled: true, writable: false },
      { id, enabled: true, writable: true },
      { id, enabled: false, writable: false },
    ]);
  },
};

/** The server refuses a change: the switch stays as it was, and the card says why. */
export const Refused: Story = {
  parameters: served([MINIO_BUCKET], { mcpRefusal: 'The database is read-only right now.' }).parameters,
  play: async ({ canvas }) => {
    const artifacts = await sectionOf(canvas, 'Artifacts');
    await userEvent.click(switchesOf(artifacts).reachable);
    await expect(await canvas.findByText('Could not change MCP for Artifacts')).toBeInTheDocument();
    await expect(canvas.getByText('The database is read-only right now.')).toBeInTheDocument();
    await expect(switchesOf(artifacts).reachable).not.toBeChecked();
  },
};

/** No buckets yet: one line, and a way to add one. */
export const Empty: Story = {
  parameters: served([]).parameters,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/No buckets yet/)).toBeInTheDocument();
    await expect(canvas.getByRole('link', { name: 'Add a bucket' })).toHaveAttribute('href', settingsLink('buckets'));
  },
};

/** Before the answer lands. */
export const Loading: Story = {
  parameters: { apolloClient: { resolvers: bucketServer([MINIO_BUCKET]).resolvers, delay: 100_000 } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveAccessibleName('Loading');
    await expect(canvas.queryByText(/No buckets yet/)).not.toBeInTheDocument();
  },
};

/** The server failed: the reason and a way to ask again, never "no buckets". */
export const Failed: Story = {
  parameters: {
    apolloClient: {
      resolvers: {
        Query: {
          ...bucketServer([]).resolvers.Query,
          buckets: () => {
            throw new Error('The database is not answering');
          },
        },
      },
    },
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/Could not load your buckets/)).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    await expect(canvas.queryByText(/No buckets yet/)).not.toBeInTheDocument();
  },
};

/** Phone width: the switches stay beside their titles, the command wraps, and nothing scrolls sideways. */
export const Narrow: Story = {
  parameters: served([READABLE, WRITABLE]).parameters,
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvas, canvasElement }) => {
    const artifacts = await sectionOf(canvas, 'Artifacts');
    await expect(switchesOf(artifacts).reachable).toBeVisible();
    await expect(artifacts.getByRole('button', { name: 'Copy the Claude Code command for Artifacts' })).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
