import { useApolloClient, useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';
import { Link } from 'react-router';
import { ConfirmButton } from '@/components/confirm-button';
import { TagFormDialog, type TagFormValues } from '@/components/domain/tag-form-dialog';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ColorDot } from '@/components/ui/color-dot';
import { Pencil, Plus, Tag, Trash2 } from '@/components/ui/icons';
import { messageOf } from '@/lib/error-message';
import { LIBRARY_QUERIES } from '@/lib/library';
import { queryLike } from '@/lib/query';
import { tagDocumentsPath } from '@/lib/routes';
import {
  CreateTag,
  DeleteTag,
  describeDocumentCount,
  type ListedTag,
  sortTags,
  TAG_QUERIES,
  TagList,
  UpdateTag,
} from '@/lib/tags';

/**
 * What deleting a tag costs, said before it is done.
 *
 * @param tag - The tag, with its count.
 * @returns The confirm's description.
 */
function deleteDescription(tag: ListedTag): string {
  const { count } = tag.documentsAggregate;
  const kept = 'The documents themselves stay, with their other tags.';
  if (count === 0) {
    return `No document carries it. ${kept}`;
  }
  if (count === 1) {
    return `It comes off the one document that carries it. ${kept}`;
  }
  return `It comes off the ${count} documents that carry it. ${kept}`;
}

/**
 * The owner's tags: each with its colour and how many documents carry it, a link to those documents, and Edit and
 * Delete beside it. New tag, and Edit, open a form in a dialog; nothing is edited where it sits. Deleting asks
 * first, saying how many documents lose the tag.
 *
 * @returns The tags page.
 */
export function TagsRoute() {
  const result = useQuery(TagList);
  const client = useApolloClient();
  const [createTag] = useMutation(CreateTag);
  const [updateTag] = useMutation(UpdateTag);
  const [deleteTag] = useMutation(DeleteTag);
  const [editing, setEditing] = useState<ListedTag | 'new' | null>(null);
  const [failure, setFailure] = useState<{ title: string; message: string } | null>(null);
  const tags = sortTags(result.data?.tags ?? []);

  // The tags of every document in the list and the tree come with the library, so it is read again too.
  const refresh = () => client.refetchQueries({ include: [...TAG_QUERIES, ...LIBRARY_QUERIES] });

  async function save(values: TagFormValues) {
    if (editing === 'new') {
      await createTag({ variables: values });
    } else if (editing !== null) {
      await updateTag({ variables: { id: editing.id, ...values } });
    }
    await refresh();
  }

  async function remove(tag: ListedTag) {
    setFailure(null);
    try {
      await deleteTag({ variables: { id: tag.id } });
    } catch (error) {
      setFailure({ title: `Could not delete “${tag.name}”`, message: messageOf(error) ?? 'The server refused it' });
      return;
    }
    client.cache.evict({ id: client.cache.identify({ __typename: 'Tag', id: tag.id }) });
    client.cache.gc();
    await refresh();
  }

  const newButton = (
    <Button variant="info" size="sm" iconSlot={<Plus />} content="New tag" onClick={() => setEditing('new')} />
  );

  return (
    <>
      <PageLayout
        iconSlot={<Tag />}
        title="Tags"
        description="How your documents are organised. A document can carry any number, and the list filters by them."
        actionSlot={tags.length > 0 ? newButton : undefined}
        contentSlot={
          <div className="grid gap-4 pb-4">
            {failure && <Alert variant="destructive" title={failure.title} description={failure.message} />}
            <LoadState
              query={queryLike(result)}
              what="your tags"
              count={tags.length}
              emptySlot={
                <EmptyState
                  level={2}
                  iconSlot={<Tag />}
                  title="No tags yet"
                  description="Make one here, or as you tag a document on its page. Agents can tag what they upload too."
                  actionSlot={newButton}
                />
              }
            />
            <List
              label="Tags"
              contentSlot={tags.map((tag) => (
                <ListItem
                  key={tag.id}
                  leadingSlot={<ColorDot color={tag.color} size="md" />}
                  title={tag.name}
                  meta={describeDocumentCount(tag.documentsAggregate.count)}
                  linkSlot={<Link to={tagDocumentsPath(tag.id)} />}
                  actionSlot={
                    <>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label={`Edit ${tag.name}`}
                        hint="Rename or recolour"
                        iconSlot={<Pencil />}
                        onClick={() => setEditing(tag)}
                      />
                      <ConfirmButton
                        size="icon-sm"
                        aria-label={`Delete ${tag.name}`}
                        hint="Delete the tag"
                        iconSlot={<Trash2 />}
                        title={`Delete “${tag.name}”?`}
                        description={deleteDescription(tag)}
                        onConfirm={() => void remove(tag)}
                      />
                    </>
                  }
                />
              ))}
            />
          </div>
        }
      />
      {editing !== null && (
        <TagFormDialog tag={editing === 'new' ? null : editing} onSave={save} onClose={() => setEditing(null)} />
      )}
    </>
  );
}
