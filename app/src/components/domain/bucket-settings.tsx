import { CombinedGraphQLErrors } from '@apollo/client/errors';
import { useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';
import { graphql } from '@/__generated__';
import type { BucketSettingsQuery } from '@/__generated__/graphql';
import { CardLayout } from '@/components/card-layout';
import { ConfirmButton } from '@/components/confirm-button';
import { Star } from '@/components/domain/app-icons';
import { BucketFormDialog, type EditableBucket } from '@/components/domain/bucket-form-dialog';
import { type BucketTestOutcome, BucketTestReport } from '@/components/domain/bucket-test-report';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Ellipsis, KeyRound, Pencil, PlugZap, Plus, Trash2 } from '@/components/ui/icons';
import { ItemDescription, ItemTitle } from '@/components/ui/item';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { messageOf } from '@/lib/error-message';
import { joinStats } from '@/lib/format';
import { queryLike } from '@/lib/query';

const BucketList = graphql(`
  query BucketSettings {
    buckets {
      id
      slug
      name
      provider
      endpoint
      publicEndpoint
      region
      bucket
      accessKeyId
      forcePathStyle
      isDefault
      secretReadable
    }
    bucketPresets {
      provider
      label
      forcePathStyle
      defaultRegion
      endpointRequired
      regionRequired
      endpointExample
    }
  }
`);

const TestSavedBucket = graphql(`
  mutation TestSavedBucket($input: BucketInput!, $id: UUID) {
    testBucket(input: $input, id: $id) {
      ok
      shareLinkWarning
      steps {
        step
        ok
        skipped
        errorCode
        message
      }
    }
  }
`);

const SetDefaultBucket = graphql(`
  mutation SetDefaultBucket($id: UUID!) {
    setDefaultBucket(id: $id) {
      id
      isDefault
    }
  }
`);

const DeleteBucket = graphql(`
  mutation DeleteBucket($id: UUID!, $forgetDocuments: Boolean) {
    deleteBucket(id: $id, forgetDocuments: $forgetDocuments)
  }
`);

/** A bucket as the list reads it. */
type BucketRow = BucketSettingsQuery['buckets'][number];

/** The code the server refuses a delete with while documents still point at the bucket. */
const IN_USE = 'CONFLICT';

/** A refused removal: which bucket, why, and whether forgetting its documents would let it go. */
interface Refusal {
  bucket: BucketRow;
  message: string;
  inUse: boolean;
}

/** One bucket's last test: running, its outcome, or why it could not run. */
interface TestState {
  running: boolean;
  outcome: BucketTestOutcome | null;
  failure: string | undefined;
}

/**
 * Where a bucket is, short enough for a list row: the endpoint's host, or the region on AWS,
 * whose endpoint is left blank for the regional default.
 *
 * @param bucket - The bucket.
 * @returns The host, or the region.
 */
function whereOf(bucket: Pick<BucketRow, 'endpoint' | 'region'>): string {
  if (bucket.endpoint === null) {
    return bucket.region;
  }
  try {
    return new URL(bucket.endpoint).host;
  } catch {
    return bucket.endpoint;
  }
}

/**
 * Default first, then by name, so the list reads the same however the server orders it.
 *
 * @param buckets - The buckets.
 * @returns A sorted copy.
 */
function sorted(buckets: readonly BucketRow[]): BucketRow[] {
  return [...buckets].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

/**
 * Whether a failed request is the server saying the bucket still has documents.
 *
 * @param error - What the mutation threw.
 * @returns True for that refusal.
 */
function isInUse(error: unknown): boolean {
  return CombinedGraphQLErrors.is(error) && error.errors.some((entry) => entry.extensions?.code === IN_USE);
}

/**
 * Settings' Buckets card: where documents are stored. Each bucket is on its own provider and
 * account, so a row says which, and where. A bucket can be tested, made the default, edited and
 * removed; a secret that can no longer be read says so and asks for it again.
 *
 * @returns The card, and the add/edit dialog or the remove question while one is open.
 */
export function BucketSettings() {
  const result = useQuery(BucketList);
  const [testBucket] = useMutation(TestSavedBucket);
  const [setDefaultBucket] = useMutation(SetDefaultBucket);
  const [deleteBucket] = useMutation(DeleteBucket);
  const [editing, setEditing] = useState<EditableBucket | 'new' | null>(null);
  const [removing, setRemoving] = useState<BucketRow | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [failure, setFailure] = useState<string | undefined>();
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const buckets = sorted(result.data?.buckets ?? []);
  const presets = result.data?.bucketPresets ?? [];

  const providerOf = (bucket: BucketRow) =>
    presets.find((preset) => preset.provider === bucket.provider)?.label ?? bucket.provider;

  async function test(bucket: BucketRow) {
    setTests((all) => ({ ...all, [bucket.id]: { running: true, outcome: null, failure: undefined } }));
    let next: TestState = { running: false, outcome: null, failure: undefined };
    try {
      const { data } = await testBucket({
        variables: {
          id: bucket.id,
          input: {
            name: bucket.name,
            slug: bucket.slug,
            provider: bucket.provider,
            endpoint: bucket.endpoint,
            publicEndpoint: bucket.publicEndpoint,
            region: bucket.region,
            bucket: bucket.bucket,
            accessKeyId: bucket.accessKeyId,
            forcePathStyle: bucket.forcePathStyle,
          },
        },
      });
      next = { ...next, outcome: data?.testBucket ?? null };
    } catch (error) {
      next = { ...next, failure: messageOf(error) ?? 'The server did not answer' };
    }
    setTests((all) => ({ ...all, [bucket.id]: next }));
  }

  async function makeDefault(bucket: BucketRow) {
    setFailure(undefined);
    try {
      await setDefaultBucket({ variables: { id: bucket.id } });
      await result.refetch();
    } catch (error) {
      setFailure(messageOf(error) ?? 'The server refused it');
    }
  }

  async function remove(bucket: BucketRow, forgetDocuments: boolean) {
    setRemoving(null);
    setRefusal(null);
    try {
      await deleteBucket({ variables: { id: bucket.id, forgetDocuments } });
      await result.refetch();
    } catch (error) {
      setRefusal({ bucket, message: messageOf(error) ?? 'The server refused it', inUse: isInUse(error) });
    }
  }

  const addButton = (
    <Button variant="info" size="sm" iconSlot={<Plus />} content="Add bucket" onClick={() => setEditing('new')} />
  );

  return (
    <>
      <CardLayout
        level={2}
        title="Buckets"
        description="Where documents are stored. Each bucket has its own provider, account and keys; uploads go to the default unless another is chosen."
        actionSlot={buckets.length > 0 ? addButton : undefined}
        contentSlot={
          <div className="grid gap-4">
            {failure && <Alert variant="destructive" title="Could not change the default" description={failure} />}
            {refusal && (
              <Alert
                variant="destructive"
                title={`Could not remove “${refusal.bucket.name}”`}
                description={refusal.message}
                actionSlot={
                  refusal.inUse ? (
                    <ConfirmButton
                      size="sm"
                      content="Forget its documents"
                      title={`Forget the documents in “${refusal.bucket.name}”?`}
                      description="Their records leave this instance and the bucket is removed. The objects stay in the bucket, untouched."
                      confirmLabel="Forget and remove"
                      onConfirm={() => void remove(refusal.bucket, true)}
                    />
                  ) : undefined
                }
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
                    title="No buckets yet. Add one to start uploading documents."
                    actionSlot={addButton}
                  />
                }
              />
            ) : (
              <List
                label="Buckets"
                contentSlot={buckets.map((bucket) => (
                  <BucketListRow
                    key={bucket.id}
                    bucket={bucket}
                    providerLabel={providerOf(bucket)}
                    test={tests[bucket.id]}
                    onTest={() => void test(bucket)}
                    onMakeDefault={() => void makeDefault(bucket)}
                    onEdit={() => setEditing(bucket)}
                    onRemove={() => setRemoving(bucket)}
                  />
                ))}
              />
            )}
          </div>
        }
      />

      {editing !== null && (
        <BucketFormDialog
          bucket={editing === 'new' ? undefined : editing}
          onSaved={() => result.refetch()}
          onClose={() => setEditing(null)}
        />
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (open === false) {
            setRemoving(null);
          }
        }}
        title={`Remove “${removing?.name ?? ''}”?`}
        description="This instance stops using it, and MCP clients lose its address. The bucket and every object in it stay as they are at the provider."
        confirmLabel="Remove"
        onConfirm={() => {
          if (removing) {
            void remove(removing, false);
          }
        }}
      />
    </>
  );
}

interface BucketListRowProps {
  bucket: BucketRow;
  /** The provider's name, from the presets. */
  providerLabel: string;
  /** Its last test, if one was run here. */
  test: TestState | undefined;
  onTest: () => void;
  onMakeDefault: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

/**
 * One bucket in the list: its name, whether it is the default, which provider and where, and its
 * actions. A test's report opens under the row.
 *
 * @param props - The bucket, its last test, and what each action calls.
 * @returns The row.
 */
function BucketListRow({ bucket, providerLabel, test, onTest, onMakeDefault, onEdit, onRemove }: BucketListRowProps) {
  const isUnreadable = bucket.secretReadable === false;

  return (
    <div className="grid gap-2">
      <ListItem
        title={
          <ItemTitle className="min-w-0 flex-wrap">
            <span className="truncate">{bucket.name}</span>
            {bucket.isDefault && <Badge variant="info-soft">Default</Badge>}
            {isUnreadable && <Badge variant="warning-soft">Secret unreadable</Badge>}
          </ItemTitle>
        }
        description={
          <ItemDescription>
            {joinStats(providerLabel, whereOf(bucket), bucket.bucket)}
            <span className="block font-mono text-xs">{`Key ${bucket.accessKeyId}`}</span>
          </ItemDescription>
        }
        actionSlot={
          <>
            {isUnreadable ? (
              <Button size="sm" variant="outline" iconSlot={<KeyRound />} content="Re-enter secret" onClick={onEdit} />
            ) : (
              <Button
                size="sm"
                variant="outline"
                iconSlot={<PlugZap />}
                content="Test"
                aria-label={`Test ${bucket.name}`}
                loading={test?.running}
                loadingLabel="Testing…"
                onClick={onTest}
              />
            )}
            <Menu>
              <MenuTrigger asChild>
                <Button
                  aria-label={`More for ${bucket.name}`}
                  variant="outline"
                  size="icon-sm"
                  iconSlot={<Ellipsis />}
                />
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem
                  iconSlot={<Star />}
                  label="Make default"
                  disabled={bucket.isDefault}
                  onSelect={onMakeDefault}
                />
                <MenuItem iconSlot={<Pencil />} label="Edit" onSelect={onEdit} />
                <MenuSeparator />
                <MenuItem iconSlot={<Trash2 />} label="Remove" destructive onSelect={onRemove} />
              </MenuContent>
            </Menu>
          </>
        }
      />
      {test?.failure && (
        <div className="px-3 pb-2">
          <Alert variant="destructive" title="Could not run the test" description={test.failure} />
        </div>
      )}
      {test?.outcome && (
        <div className="px-3 pb-2">
          <BucketTestReport outcome={test.outcome} />
        </div>
      )}
    </div>
  );
}
