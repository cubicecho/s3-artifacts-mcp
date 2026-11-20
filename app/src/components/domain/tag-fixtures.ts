import { GraphQLError } from 'graphql';
import type { BucketFixture } from '@/components/domain/bucket-fixtures';
import { type DocumentFixture, documentServer, USER_ID } from '@/components/domain/document-fixtures';
import { mergeResolvers } from '@/components/domain/share-link-fixtures';
import { clientId } from '@/lib/id';

// Tags as the server answers them, and a mock server whose mutations really change them and the documents that
// carry them. A document's tags are the very objects held here, so a rename or a recolour shows on every document
// at once, as Apollo's cache shows it. The server runs against the real SDL, as every mock server here does.

/** A tag as `tags` answers it. */
export interface TagFixture {
  id: string;
  userId: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

let made = 0;
// The counter's digits in a made-up id, so `7a000012-…` is still a UUID's eight.
const ID_DIGITS = 6;

/**
 * A tag of the owner's.
 *
 * @param name - Its name.
 * @param color - Its colour, `#rrggbb`.
 * @returns The fixture.
 */
export function tagFixture(name: string, color: string): TagFixture {
  made += 1;
  return {
    id: `7a${String(made).padStart(ID_DIGITS, '0')}-1b2c-4d3e-8f40-516273849506`,
    userId: USER_ID,
    name,
    color,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
  };
}

/** Invoices and receipts. */
export const FINANCE_TAG = tagFixture('Finance', '#22c55e');
/** What a quarter's reporting is filed under. */
export const Q4_TAG = tagFixture('Q4', '#6366f1');
/** Not finished. */
export const DRAFT_TAG = tagFixture('Draft', '#eab308');
/** What an agent wrote. */
export const AGENT_TAG = tagFixture('Agent output', '#ec4899');

/** A few tags, as a library that has been tagged a while has. */
export const MIXED_TAGS: readonly TagFixture[] = [FINANCE_TAG, Q4_TAG, DRAFT_TAG, AGENT_TAG];

/** What the mock server is told to do. */
interface TagServerOptions {
  /** When set, `tags` fails with this message. */
  failTags?: string;
  /** When set, `createTag` and `updateTag` refuse with this message and code. */
  saveRefusal?: { message: string; code: string };
  /** When set, `deleteTag` refuses with this message. */
  deleteRefusal?: string;
  /** When set, `setDocumentTags` and `bulkTagDocuments` refuse with this message. */
  tagRefusal?: string;
}

/** Each document's tags, by document id, by tag: who carries what when a story starts. */
export type TagLinks = Readonly<Record<string, readonly TagFixture[]>>;

/**
 * A server holding tags over a list of documents that another mock server owns, so tagging a document changes the
 * same row the library lists.
 *
 * @param documents - The live documents, `documentServer`'s.
 * @param startTags - The tags it starts with.
 * @param options - How its reads and mutations answer.
 * @returns The resolvers, the live tags and the call logs for a story to inspect.
 */
export function tagServer(
  documents: DocumentFixture[],
  startTags: readonly TagFixture[] = [],
  options: TagServerOptions = {},
) {
  // Copies, so a story that renames one does not rename it for the next.
  const tags = startTags.map((tag) => ({ ...tag }));
  const copyOf = new Map(startTags.map((tag, index) => [tag.id, tags[index]]));
  for (const document of documents) {
    document.tags = document.tags.flatMap((tag) => copyOf.get(tag.id) ?? []);
  }
  const calls = {
    setDocumentTags: [] as { documentId: string; tagIds: readonly string[] }[],
    bulkTagDocuments: [] as { documentIds: readonly string[]; add: readonly string[]; remove: readonly string[] }[],
  };

  const findTag = (id: string) => {
    const tag = tags.find((entry) => entry.id === id);
    if (tag === undefined) {
      throw new GraphQLError('Tag not found.', { extensions: { code: 'NOT_FOUND' } });
    }
    return tag;
  };
  const findDocument = (id: string) => {
    const document = documents.find((entry) => entry.id === id);
    if (document === undefined) {
      throw new GraphQLError('Document not found.', { extensions: { code: 'NOT_FOUND' } });
    }
    return document;
  };
  const refuseSave = () => {
    if (options.saveRefusal) {
      throw new GraphQLError(options.saveRefusal.message, { extensions: { code: options.saveRefusal.code } });
    }
  };
  const refuseTagging = () => {
    if (options.tagRefusal) {
      throw new GraphQLError(options.tagRefusal, { extensions: { code: 'NOT_FOUND' } });
    }
  };
  const requireFreeName = (name: string, exceptId: string | null) => {
    const taken = tags.find((tag) => tag.id !== exceptId && tag.name.toLowerCase() === name.toLowerCase());
    if (taken) {
      throw new GraphQLError(`You already have a tag called “${name}”. Tag names are unique, ignoring case.`, {
        extensions: { code: 'CONFLICT' },
      });
    }
  };

  const resolvers = {
    Query: {
      tags: () => {
        if (options.failTags) {
          throw new Error(options.failTags);
        }
        return tags;
      },
    },
    Tag: {
      documentsAggregate: (tag: TagFixture, args: { where?: { status?: { eq?: string | null } | null } | null }) => ({
        count: documents.filter(
          (document) =>
            document.tags.some((entry) => entry.id === tag.id) &&
            (args.where?.status?.eq == null || document.status === args.where.status.eq),
        ).length,
      }),
    },
    Mutation: {
      createTag: (_parent: unknown, args: { name: string; color?: string | null }) => {
        refuseSave();
        const name = args.name.trim();
        requireFreeName(name, null);
        const now = new Date().toISOString();
        const tag: TagFixture = {
          id: clientId(),
          userId: USER_ID,
          name,
          color: args.color ?? '#64748b',
          createdAt: now,
          updatedAt: now,
        };
        tags.push(tag);
        return tag;
      },
      updateTag: (_parent: unknown, args: { id: string; name?: string | null; color?: string | null }) => {
        refuseSave();
        const tag = findTag(args.id);
        if (args.name != null) {
          requireFreeName(args.name.trim(), tag.id);
          tag.name = args.name.trim();
        }
        if (args.color != null) {
          tag.color = args.color;
        }
        return tag;
      },
      deleteTag: (_parent: unknown, args: { id: string }) => {
        if (options.deleteRefusal) {
          throw new GraphQLError(options.deleteRefusal, { extensions: { code: 'NOT_FOUND' } });
        }
        const tag = findTag(args.id);
        tags.splice(tags.indexOf(tag), 1);
        for (const document of documents) {
          document.tags = document.tags.filter((entry) => entry.id !== tag.id);
        }
        return true;
      },
      setDocumentTags: (_parent: unknown, args: { documentId: string; tagIds: readonly string[] }) => {
        calls.setDocumentTags.push(args);
        refuseTagging();
        const document = findDocument(args.documentId);
        document.tags = [...new Set(args.tagIds)].map(findTag);
        return document;
      },
      bulkTagDocuments: (
        _parent: unknown,
        args: { documentIds: readonly string[]; add?: readonly string[] | null; remove?: readonly string[] | null },
      ) => {
        const add = args.add ?? [];
        const remove = args.remove ?? [];
        calls.bulkTagDocuments.push({ documentIds: args.documentIds, add, remove });
        refuseTagging();
        const chosen = args.documentIds.map(findDocument);
        const adding = add.map(findTag);
        for (const document of chosen) {
          const kept = document.tags.filter((tag) => remove.includes(tag.id) === false);
          document.tags = [...kept, ...adding.filter((tag) => kept.includes(tag) === false)];
        }
        return chosen;
      },
    },
  };

  return { resolvers, tags, calls };
}

/**
 * The buckets and documents of `documentServer` with the tags of `tagServer` over them, sharing one list of
 * documents, so a tag put on in the list shows on the document's page and in the tag's count.
 *
 * @param buckets - The buckets.
 * @param documents - The documents in them.
 * @param startTags - The tags.
 * @param links - Which document carries which tags when the story starts, by document id.
 * @param options - How the tag half answers.
 * @returns Both servers and their resolvers merged.
 */
export function taggingServer(
  buckets: readonly BucketFixture[],
  documents: readonly DocumentFixture[],
  startTags: readonly TagFixture[] = MIXED_TAGS,
  links: TagLinks = {},
  options: TagServerOptions = {},
) {
  const library = documentServer(buckets, documents, { stepMs: 10 });
  for (const document of library.documents) {
    document.tags = [...(links[document.id] ?? document.tags)];
  }
  const tagging = tagServer(library.documents, startTags, options);
  return { library, tagging, resolvers: mergeResolvers(library.resolvers, tagging.resolvers) };
}
