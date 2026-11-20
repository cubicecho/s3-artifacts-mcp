import { useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';
import { Link } from 'react-router';
import { graphql } from '@/__generated__';
import type { McpSettingsQuery } from '@/__generated__/graphql';
import { CardLayout } from '@/components/card-layout';
import { EmptyState } from '@/components/empty-state';
import { LoadState } from '@/components/load-state';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Section } from '@/components/section';
import { SettingRow } from '@/components/setting-row';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { CopyButton } from '@/components/ui/copy-button';
import { KeyRound } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';
import { messageOf } from '@/lib/error-message';
import { claudeMcpAddCommand, mcpEndpoint } from '@/lib/mcp';
import { queryLike } from '@/lib/query';
import { settingsLink } from '@/lib/settings-tabs';

const McpBuckets = graphql(`
  query McpSettings {
    buckets {
      id
      slug
      name
      mcpEnabled
      mcpWritable
    }
  }
`);

const SetBucketMcp = graphql(`
  mutation SetBucketMcp($id: UUID!, $enabled: Boolean!, $writable: Boolean!) {
    setBucketMcp(id: $id, enabled: $enabled, writable: $writable) {
      id
      mcpEnabled
      mcpWritable
    }
  }
`);

/** A bucket as this tab reads it. */
type McpBucket = McpSettingsQuery['buckets'][number];

/** What one bucket's section is given. */
interface BucketMcpSectionProps {
  bucket: McpBucket;
  /** Where this instance is reached, which the endpoint URL starts with. */
  origin: string;
  /** Whether a change to this bucket is on its way, so its switches wait. */
  saving: boolean;
  /** Asks for the bucket's switches to be set. */
  onChange: (enabled: boolean, writable: boolean) => void;
}

/** One bucket's MCP switches, and, while it is reachable, its endpoint and the command that connects to it. */
function BucketMcpSection({ bucket, origin, saving, onChange }: BucketMcpSectionProps) {
  const endpoint = mcpEndpoint(origin, bucket.slug);
  const command = claudeMcpAddCommand(bucket.slug, endpoint);
  const isWritableLocked = bucket.mcpEnabled === false;

  return (
    <Section
      level={3}
      divider
      title={bucket.name}
      contentClassName="gap-4"
      contentSlot={
        <>
          <SettingRow
            title="Reachable over MCP"
            description="An agent with an API key can list and read this bucket's documents, and no other bucket's. Off, its endpoint answers as if it did not exist."
            actionSlot={({ titleId, descriptionId }) => (
              <Switch
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
                checked={bucket.mcpEnabled}
                disabled={saving}
                // Switched off, it can no longer be written to either.
                onCheckedChange={(enabled) => onChange(enabled, enabled && bucket.mcpWritable)}
              />
            )}
          />
          <SettingRow
            title="Writable"
            description="The agent may also upload files to it and make share links, which open for anyone holding them until they expire."
            actionSlot={({ titleId, descriptionId }) => (
              <Switch
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
                checked={bucket.mcpWritable}
                disabled={saving || isWritableLocked}
                hint={isWritableLocked ? 'Make the bucket reachable over MCP first' : undefined}
                onCheckedChange={(writable) => onChange(bucket.mcpEnabled, writable)}
              />
            )}
          />
          {bucket.mcpEnabled && (
            <>
              <PropertyList
                contentSlot={
                  <PropertyRow
                    label="Endpoint"
                    value={endpoint}
                    valueClassName="font-mono text-xs break-all"
                    hint="Streamable HTTP. Send an API key as x-api-key or Authorization: Bearer."
                    actionSlot={<CopyButton value={endpoint} label={`Copy the endpoint of ${bucket.name}`} />}
                  />
                }
              />
              <CodeBlock
                title="Claude Code"
                language="bash"
                content={command}
                wrap
                actionSlot={<CopyButton value={command} label={`Copy the Claude Code command for ${bucket.name}`} />}
              />
            </>
          )}
        </>
      }
    />
  );
}

/**
 * Settings' MCP tab: per bucket, whether an agent may reach it and write to it, its endpoint, and the command that
 * connects Claude Code. The keys agents sign in with are on the API keys tab, which it links to.
 */
export function McpSettings() {
  const result = useQuery(McpBuckets);
  const [setBucketMcp] = useMutation(SetBucketMcp);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ name: string; message: string } | undefined>();
  const buckets = result.data?.buckets ?? [];
  const origin = globalThis.location?.origin ?? '';

  async function change(bucket: McpBucket, enabled: boolean, writable: boolean) {
    setFailure(undefined);
    setSavingId(bucket.id);
    try {
      await setBucketMcp({ variables: { id: bucket.id, enabled, writable } });
    } catch (error) {
      setFailure({ name: bucket.name, message: messageOf(error) ?? 'The server refused it' });
    } finally {
      setSavingId(null);
    }
  }

  return (
    <CardLayout
      level={2}
      title="MCP"
      description="Each bucket has its own endpoint. An agent connected to one, such as Claude Code, sees that bucket and nothing else, and signs in with an API key."
      contentClassName="gap-6"
      contentSlot={
        <>
          {failure && (
            <Alert
              variant="destructive"
              title={`Could not change MCP for ${failure.name}`}
              description={failure.message}
            />
          )}
          {buckets.length === 0 ? (
            <LoadState
              compact
              query={queryLike(result)}
              what="your buckets"
              count={buckets.length}
              emptySlot={
                <EmptyState
                  compact
                  title="No buckets yet. Add one, then choose here whether agents may reach it."
                  actionSlot={
                    <Button
                      size="sm"
                      variant="outline"
                      content="Add a bucket"
                      linkSlot={<Link to={settingsLink('buckets')} />}
                    />
                  }
                />
              }
            />
          ) : (
            buckets.map((bucket) => (
              <BucketMcpSection
                key={bucket.id}
                bucket={bucket}
                origin={origin}
                saving={savingId === bucket.id}
                onChange={(enabled, writable) => void change(bucket, enabled, writable)}
              />
            ))
          )}
        </>
      }
      footerActionsSlot={
        <Button
          variant="outline"
          iconSlot={<KeyRound />}
          content="Manage API keys"
          linkSlot={<Link to={settingsLink('api-keys')} />}
        />
      }
    />
  );
}
