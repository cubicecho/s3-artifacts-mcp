import { graphql } from '@/__generated__';
import type { TagListQuery } from '@/__generated__/graphql';
import type { SelectOption } from '@/lib/select-options';

/**
 * A tag as every chip and picker draws it. The tags of a document in the library, on the document
 * page and in a mutation's answer all select these, so Apollo keeps one copy of each tag and a
 * rename or a recolour shows everywhere at once.
 */
export const TagFields = graphql(`
  fragment TagFields on Tag {
    id
    name
    color
  }
`);

/**
 * Every tag of the owner's, with how many ready documents carry each: what the tags page lists,
 * and what the picker, the bulk dialog and the list's filter offer.
 */
export const TagList = graphql(`
  query TagList {
    tags {
      ...TagFields
      documentsAggregate(where: { status: { eq: ready } }) {
        count
      }
    }
  }
`);

export const CreateTag = graphql(`
  mutation CreateTag($name: String!, $color: String) {
    createTag(name: $name, color: $color) {
      ...TagFields
    }
  }
`);

export const UpdateTag = graphql(`
  mutation UpdateTag($id: UUID!, $name: String, $color: String) {
    updateTag(id: $id, name: $name, color: $color) {
      ...TagFields
    }
  }
`);

export const DeleteTag = graphql(`
  mutation DeleteTag($id: UUID!) {
    deleteTag(id: $id)
  }
`);

export const SetDocumentTags = graphql(`
  mutation SetDocumentTags($documentId: UUID!, $tagIds: [UUID!]!) {
    setDocumentTags(documentId: $documentId, tagIds: $tagIds) {
      id
      tags {
        ...TagFields
      }
    }
  }
`);

export const BulkTagDocuments = graphql(`
  mutation BulkTagDocuments($documentIds: [UUID!]!, $add: [UUID!], $remove: [UUID!]) {
    bulkTagDocuments(documentIds: $documentIds, add: $add, remove: $remove) {
      id
      tags {
        ...TagFields
      }
    }
  }
`);

/** The queries a tag made, changed or deleted changes, by operation name, for `refetchQueries`. */
export const TAG_QUERIES = ['TagList'] as const;

/** A tag as chips and pickers draw it. */
export interface TagChipData {
  id: string;
  name: string;
  color: string;
}

/** A tag as the tag list has it, with its count. */
export type ListedTag = TagListQuery['tags'][number];

/**
 * By name, ignoring case, so a list reads the same however the server orders it.
 *
 * @param tags - The tags.
 * @returns A sorted copy.
 */
export function sortTags<T extends { name: string }>(tags: readonly T[]): T[] {
  return [...tags].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

/**
 * The tags as a combobox's options, sorted, each with its colour's dot.
 *
 * @param tags - The tags.
 * @returns The options, valued by id.
 */
export function tagOptions(tags: readonly TagChipData[]): SelectOption[] {
  return sortTags(tags).map((tag) => ({ value: tag.id, label: tag.name, color: tag.color }));
}

/**
 * How many documents a count is, in words.
 *
 * @param count - How many.
 * @returns "1 document", "3 documents", "No documents".
 */
export function describeDocumentCount(count: number): string {
  if (count === 0) {
    return 'No documents';
  }
  return count === 1 ? '1 document' : `${count} documents`;
}
