import { useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';
import { graphql } from '@/__generated__';
import type { ShareLinkState } from '@/__generated__/graphql';
import { CardLayout } from '@/components/card-layout';
import { DeleteShareLink, ShareLinkList } from '@/components/domain/share-link-list';
import { EmptyState } from '@/components/empty-state';
import { LoadState } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { SegmentedButton, SegmentedGroup } from '@/components/ui/segmented';
import { messageOf } from '@/lib/error-message';
import { queryLike } from '@/lib/query';
import { STATE_LABELS } from '@/lib/share-links';

const ShareLinks = graphql(`
  query ShareLinks {
    shareLinks(orderBy: { createdAt: { direction: desc, priority: 1 } }) {
      ...ShareLinkRow
    }
  }
`);

/** The filter that shows every link. */
const ALL = 'all';
/** What the list can be filtered to: every link, or one state. */
type LinkFilter = typeof ALL | ShareLinkState;

/** The filters, in the order the pills are drawn. */
const FILTERS: readonly LinkFilter[] = [ALL, 'active', 'expired', 'revoked'];

/** What the list says when a filter leaves nothing. */
const FILTERED_EMPTY: Readonly<Record<ShareLinkState, string>> = Object.freeze({
  active: 'No link opens right now.',
  expired: 'No link has expired.',
  revoked: 'No link has been revoked.',
});

/**
 * Settings' Share links tab: every link of every document, filterable by state, each with Copy, Remove from
 * list and a way to its document.
 *
 * @returns The card.
 */
export function ShareLinkSettings() {
  const result = useQuery(ShareLinks);
  const [deleteShareLink] = useMutation(DeleteShareLink);
  const [filter, setFilter] = useState<LinkFilter>(ALL);
  const [failure, setFailure] = useState<{ title: string; message: string } | null>(null);
  const links = result.data?.shareLinks ?? [];
  const shown = filter === ALL ? links : links.filter((link) => link.state === filter);
  const countOf = (entry: LinkFilter) =>
    entry === ALL ? links.length : links.filter((link) => link.state === entry).length;

  async function remove(id: string) {
    setFailure(null);
    try {
      await deleteShareLink({ variables: { id } });
      await result.refetch();
    } catch (error) {
      setFailure({ title: 'Could not remove the link', message: messageOf(error) ?? 'The server refused it' });
    }
  }

  return (
    <CardLayout
      level={2}
      title="Share links"
      description="Every link made for your documents. Removing one from the list does not stop it: it works until it expires, unless its document's links are revoked."
      contentSlot={
        <div className="grid gap-4">
          {links.length > 0 && (
            <SegmentedGroup aria-label="Show" value={filter} onValueChange={setFilter} className="flex-wrap">
              {FILTERS.map((entry) => (
                <SegmentedButton key={entry} value={entry}>
                  {`${entry === ALL ? 'All' : STATE_LABELS[entry]} (${countOf(entry)})`}
                </SegmentedButton>
              ))}
            </SegmentedGroup>
          )}
          {failure && <Alert variant="destructive" title={failure.title} description={failure.message} />}
          {shown.length === 0 ? (
            <LoadState
              compact
              query={queryLike(result)}
              what="your share links"
              count={shown.length}
              emptySlot={
                <EmptyState
                  compact
                  title={
                    filter === ALL ? 'No share links yet. Share a document from its page.' : FILTERED_EMPTY[filter]
                  }
                />
              }
            />
          ) : (
            <ShareLinkList
              links={shown}
              showDocument
              onRemove={(id) => void remove(id)}
              onCopyError={() =>
                setFailure({
                  title: 'Could not copy the link',
                  message: 'This browser does not let the app use the clipboard here (it needs HTTPS).',
                })
              }
            />
          )}
        </div>
      }
    />
  );
}
