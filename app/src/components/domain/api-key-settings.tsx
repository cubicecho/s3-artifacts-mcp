import { useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';
import { graphql } from '@/__generated__';
import { CardLayout } from '@/components/card-layout';
import { ConfirmButton } from '@/components/confirm-button';
import { CreateApiKeyDialog } from '@/components/domain/create-api-key-dialog';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons';
import { messageOf } from '@/lib/error-message';
import { formatAgo, formatDate, joinStats } from '@/lib/format';
import { queryLike } from '@/lib/query';

const ApiKeys = graphql(`
  query ApiKeys {
    apiKeys {
      id
      name
      start
      lastUsedAt
      expiresAt
      createdAt
    }
  }
`);

const RevokeApiKey = graphql(`
  mutation RevokeApiKey($id: UUID!) {
    revokeApiKey(id: $id)
  }
`);

interface ApiKeyRow {
  lastUsedAt?: unknown;
  expiresAt?: unknown;
  createdAt: unknown;
}

/**
 * A key's dates on one line.
 *
 * @param key - The key's dates, as `apiKeys` answers them.
 * @returns When it was last used, when it expires and when it was made.
 */
function keyDetails(key: ApiKeyRow): string {
  return joinStats(
    key.lastUsedAt ? `Last used ${formatAgo(String(key.lastUsedAt))}` : 'Never used',
    key.expiresAt ? `Expires ${formatDate(String(key.expiresAt))}` : 'Never expires',
    `Made ${formatDate(String(key.createdAt))}`,
  );
}

/**
 * Settings' API keys card: the keys MCP clients connect with, a new one shown once, and revoking
 * one. Only the start of a key is ever listed.
 *
 * @returns The card, and the new-key dialog while it is open.
 */
export function ApiKeySettings() {
  const result = useQuery(ApiKeys);
  const [revokeApiKey] = useMutation(RevokeApiKey);
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const keys = result.data?.apiKeys ?? [];

  async function revoke(id: string) {
    setFailure(undefined);
    try {
      await revokeApiKey({ variables: { id } });
      await result.refetch();
    } catch (error) {
      setFailure(messageOf(error) ?? 'The server refused it');
    }
  }

  return (
    <>
      <CardLayout
        level={2}
        title="API keys"
        description="An MCP client signs in with a key. Give each client its own, so one can be revoked alone."
        actionSlot={
          <Button size="sm" variant="outline" iconSlot={<Plus />} content="New key" onClick={() => setCreating(true)} />
        }
        contentSlot={
          <div className="grid gap-4">
            {failure && <Alert variant="destructive" title="Could not revoke the key" description={failure} />}
            {keys.length === 0 ? (
              <LoadState
                compact
                query={queryLike(result)}
                what="your API keys"
                count={keys.length}
                emptySlot={<EmptyState compact title="No keys yet. Make one for each MCP client." />}
              />
            ) : (
              <List
                label="API keys"
                contentSlot={keys.map((key) => (
                  <ListItem
                    key={key.id}
                    title={key.name}
                    description={keyDetails(key)}
                    meta={<span className="font-mono text-foreground/60 text-xs">{`${key.start}…`}</span>}
                    actionSlot={
                      <ConfirmButton
                        size="sm"
                        variant="outline"
                        content="Revoke"
                        title={`Revoke “${key.name}”?`}
                        description="Every MCP client using this key is refused from its next call. The key cannot be brought back; make a new one instead."
                        confirmLabel="Revoke"
                        onConfirm={() => void revoke(key.id)}
                      />
                    }
                  />
                ))}
              />
            )}
          </div>
        }
      />

      {creating && <CreateApiKeyDialog onCreated={() => result.refetch()} onClose={() => setCreating(false)} />}
    </>
  );
}
