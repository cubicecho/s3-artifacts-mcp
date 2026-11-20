import { useApolloClient, useMutation, useQuery } from '@apollo/client/react';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { CardLayout } from '@/components/card-layout';
import { TagPicker } from '@/components/domain/tag-picker';
import { LoadError } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { messageOf } from '@/lib/error-message';
import { queryLike } from '@/lib/query';
import { ROUTES } from '@/lib/routes';
import { CreateTag, SetDocumentTags, TAG_QUERIES, type TagChipData, TagList } from '@/lib/tags';

/** The document as the card needs it. */
interface TaggedDocument {
  id: string;
  title: string;
  tags: readonly TagChipData[];
}

/**
 * A document's tags, chosen in the tag picker and saved on every pick. A name that matches no tag makes one and puts
 * it on, there and then. The picker shows a pick at once and the saves go one after another, so a second pick
 * before the first is saved starts from it. A refused save says why and goes back to the tags the server has.
 *
 * @param props - The document, with its tags.
 * @returns The card.
 */
export function DocumentTagsCard({ document }: { document: TaggedDocument }) {
  const list = useQuery(TagList);
  const client = useApolloClient();
  const [setDocumentTags] = useMutation(SetDocumentTags);
  const [createTag, creating] = useMutation(CreateTag);
  const [failure, setFailure] = useState<{ title: string; message: string } | null>(null);
  const [picked, setPicked] = useState<readonly TagChipData[] | null>(null);
  const saves = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(0);
  const query = queryLike(list);
  const chosen = picked ?? document.tags;
  const known = new Map([...(list.data?.tags ?? []), ...chosen].map((tag) => [tag.id, tag]));

  async function save(tagIds: readonly string[]) {
    try {
      await setDocumentTags({ variables: { documentId: document.id, tagIds: [...tagIds] } });
    } catch (error) {
      setFailure({ title: 'Could not change the tags', message: messageOf(error) ?? 'The server refused it' });
      return false;
    }
    return true;
  }

  function choose(tagIds: readonly string[], made?: TagChipData) {
    setFailure(null);
    const turn = latest.current + 1;
    latest.current = turn;
    setPicked(tagIds.flatMap((id) => (id === made?.id ? [made] : (known.get(id) ?? []))));
    saves.current = saves.current.then(async () => {
      const isSaved = await save(tagIds);
      // The document's answer has the tags now, so the picker reads them from it again; a refusal shows them too.
      if (turn === latest.current || isSaved === false) {
        setPicked(null);
      }
      if (isSaved) {
        void client.refetchQueries({ include: [...TAG_QUERIES] });
      }
    });
  }

  async function create(name: string) {
    setFailure(null);
    let made: TagChipData | undefined;
    try {
      made = (await createTag({ variables: { name } })).data?.createTag;
    } catch (error) {
      setFailure({ title: `Could not make “${name}”`, message: messageOf(error) ?? 'The server refused it' });
      return;
    }
    if (made !== undefined) {
      choose([...chosen.map((tag) => tag.id), made.id], made);
    }
  }

  return (
    <CardLayout
      level={2}
      title="Tags"
      description="Tags are how documents are organised: the list filters by them."
      actionSlot={<Button variant="outline" size="xs" content="Manage tags" linkSlot={<Link to={ROUTES.tags} />} />}
      contentSlot={
        <div className="grid gap-3">
          {query.isError ? (
            <LoadError compact error={query.error} onRetry={query.refetch} what="your tags" />
          ) : (
            <TagPicker
              label={`Tags of ${document.title}`}
              tags={list.data?.tags ?? []}
              chosen={chosen}
              onValueChange={(tagIds) => choose(tagIds)}
              onCreateTag={(name) => void create(name)}
              disabled={query.isPending || creating.loading}
              placeholder={query.isPending ? 'Loading tags…' : 'No tags'}
            />
          )}
          {failure && <Alert variant="destructive" title={failure.title} description={failure.message} />}
        </div>
      }
    />
  );
}
