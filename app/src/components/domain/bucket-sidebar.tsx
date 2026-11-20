import { useQuery } from '@apollo/client/react';
import { useMemo } from 'react';
import { Link, useMatch } from 'react-router';
import { BucketTree } from '@/components/domain/bucket-tree';
import { EmptyState } from '@/components/empty-state';
import { LoadState } from '@/components/load-state';
import { SidebarSection } from '@/components/sidebar';
import { Button } from '@/components/ui/button';
import { Library, sortBuckets } from '@/lib/library';
import { queryLike } from '@/lib/query';
import { ROUTES } from '@/lib/routes';
import { settingsLink } from '@/routes/settings';

/**
 * The bucket tree as a section of the app's sidebar, under the places: on every signed-in page,
 * with the open document marked. Under `md` the sidebar is hidden by CSS, so the documents page
 * is where a phone reaches every document.
 *
 * @returns The sidebar section.
 */
export function BucketSidebarSection() {
  const result = useQuery(Library);
  const open = useMatch(ROUTES.document)?.params.id;
  const buckets = useMemo(
    () =>
      sortBuckets(result.data?.buckets ?? []).map((bucket) => ({
        ...bucket,
        // Oldest first, so of two documents with one title the older keeps the plain name.
        documents: [...bucket.documents].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      })),
    [result.data],
  );

  return (
    <SidebarSection
      title="Buckets"
      contentSlot={
        buckets.length === 0 ? (
          <LoadState
            compact
            query={queryLike(result)}
            what="your buckets"
            count={buckets.length}
            emptySlot={
              <EmptyState
                compact
                className="px-2"
                title="No buckets yet."
                actionSlot={
                  <Button
                    variant="outline"
                    size="xs"
                    content="Add one"
                    linkSlot={<Link to={settingsLink('buckets')} />}
                  />
                }
              />
            }
          />
        ) : (
          <BucketTree buckets={buckets} selectedDocumentId={open} />
        )
      }
    />
  );
}
