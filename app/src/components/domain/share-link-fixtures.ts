import { GraphQLError } from 'graphql';
import type { ShareLinkCreator, ShareLinkPermission, ShareLinkState } from '@/__generated__/graphql';
import { MINIO_BUCKET, S3_BUCKET } from '@/components/domain/bucket-fixtures';
import { type DocumentFixture, documentServer, USER_ID } from '@/components/domain/document-fixtures';
import { MS_PER_HOUR } from '@/consts';
import { clientId } from '@/lib/id';
import { HOURS_PER_DAY } from '@/lib/share-links';

// Share links and the owner's settings as the server answers them, and a mock server whose mutations really
// change them, so a story sees a new link arrive in the list or a re-key revoke the old ones. It runs against the
// real SDL, as the other fixtures do; `url` and `state` are answered from the fixture, as the server would work
// them out.

/** A share link as `shareLinks` answers it. */
export interface ShareLinkFixture {
  id: string;
  userId: string;
  documentId: string;
  label: string | null;
  permission: ShareLinkPermission;
  objectKey: string;
  expiresAt: string;
  createdBy: ShareLinkCreator;
  createdAt: string;
  url: string | null;
  state: ShareLinkState;
}

/** The owner's settings row, as `appSettings` answers it. */
export interface AppSettingsFixture {
  userId: string;
  maxUploadBytes: number;
  defaultLinkExpiryHours: number;
  defaultLinkPermission: ShareLinkPermission;
  updatedAt: string;
}

/** What a new instance starts on. */
export const DEFAULT_SETTINGS: AppSettingsFixture = Object.freeze({
  userId: USER_ID,
  maxUploadBytes: 104_857_600,
  defaultLinkExpiryHours: 24,
  defaultLinkPermission: 'download',
  updatedAt: '2026-11-01T10:00:00.000Z',
});

/** The bounds the server checks the settings and every link against. */
export const LIMITS = Object.freeze({
  minUploadBytes: 1_048_576,
  maxUploadBytes: 53_687_091_200,
  minLinkExpiryHours: 1,
  maxLinkExpiryHours: 168,
});

/** Where a fixture's URL points: a bucket's public endpoint, signed. */
const BUCKET_ORIGIN = 'https://s3.example.com/artifacts';

let made = 0;
// The counter's digits in a made-up id, so `1c000012-…` is still a UUID's eight.
const ID_DIGITS = 6;

/**
 * A share link for a document.
 *
 * @param document - What it opens.
 * @param fields - What sets it apart.
 * @returns The fixture, active and expiring a day from now unless told otherwise.
 */
export function shareLinkFixture(
  document: Pick<DocumentFixture, 'id' | 'objectKey'>,
  fields: Partial<ShareLinkFixture> = {},
): ShareLinkFixture {
  made += 1;
  const id = fields.id ?? `1c${String(made).padStart(ID_DIGITS, '0')}-2b3c-4d5e-8f60-718293a4b5c6`;
  return {
    id,
    userId: USER_ID,
    documentId: document.id,
    label: null,
    permission: 'download',
    objectKey: document.objectKey,
    expiresAt: new Date(Date.now() + HOURS_PER_DAY * MS_PER_HOUR).toISOString(),
    createdBy: 'owner',
    createdAt: '2026-11-18T10:00:00.000Z',
    url: `${BUCKET_ORIGIN}/${encodeURIComponent(document.objectKey)}?X-Amz-Signature=${id.replaceAll('-', '')}`,
    state: 'active',
    ...fields,
  };
}

/** What the mock server is told to do. */
interface ShareLinkServerOptions {
  /** The owner's settings it starts with. */
  settings?: Partial<AppSettingsFixture>;
  /** When set, `shareLinks` and `Document.shareLinks` fail with this message. */
  failLinks?: string;
  /** When set, `appSettings` fails with this message. */
  failSettings?: string;
  /** When set, `createShareLink` refuses with this message. */
  createRefusal?: string;
  /** When set, `rekeyDocument` refuses with this message. */
  rekeyRefusal?: string;
  /** When set, `updateAppSettings` refuses with this message. */
  updateRefusal?: string;
}

/**
 * A server holding share links and the owner's settings, which its mutations really change.
 *
 * @param documents - The documents the links are for, which a re-key moves. Changed in place, as the document
 *   server's own list, so the two agree.
 * @param startLinks - The links it starts with, newest first.
 * @param options - How its reads and mutations answer.
 * @returns The resolvers, and the live list, settings and call logs for a story to inspect.
 */
export function shareLinkServer(
  documents: DocumentFixture[],
  startLinks: readonly ShareLinkFixture[] = [],
  options: ShareLinkServerOptions = {},
) {
  const links = startLinks.map((link) => ({ ...link }));
  const settings: AppSettingsFixture = { ...DEFAULT_SETTINGS, ...options.settings };
  const calls = {
    createShareLink: [] as Record<string, unknown>[],
    deleteShareLink: [] as string[],
    rekeyDocument: [] as string[],
    updateAppSettings: [] as Record<string, unknown>[],
  };

  const refuse = (message: string, code: string) => new GraphQLError(message, { extensions: { code } });
  const readLinks = () => {
    if (options.failLinks) {
      throw new Error(options.failLinks);
    }
    return links;
  };

  const resolvers = {
    Query: {
      shareLinks: () => readLinks(),
      appSettings: () => {
        if (options.failSettings) {
          throw new Error(options.failSettings);
        }
        return settings;
      },
      appSettingsLimits: () => LIMITS,
    },
    Document: {
      shareLinks: (document: DocumentFixture) => readLinks().filter((link) => link.documentId === document.id),
    },
    ShareLink: {
      document: (link: ShareLinkFixture) => documents.find((document) => document.id === link.documentId),
    },
    Mutation: {
      createShareLink: (
        _parent: unknown,
        args: {
          documentId: string;
          permission?: ShareLinkPermission | null;
          expiresInHours?: number | null;
          label?: string | null;
        },
      ) => {
        calls.createShareLink.push(args);
        if (options.createRefusal) {
          throw refuse(options.createRefusal, 'BAD_USER_INPUT');
        }
        const document = documents.find((entry) => entry.id === args.documentId);
        if (document === undefined) {
          throw refuse('Document not found.', 'NOT_FOUND');
        }
        const hours = args.expiresInHours ?? settings.defaultLinkExpiryHours;
        const link = shareLinkFixture(document, {
          id: clientId(),
          label: args.label ?? null,
          permission: args.permission ?? settings.defaultLinkPermission,
          expiresAt: new Date(Date.now() + hours * MS_PER_HOUR).toISOString(),
          createdAt: new Date().toISOString(),
        });
        links.unshift(link);
        return link;
      },
      deleteShareLink: (_parent: unknown, args: { id: string }) => {
        calls.deleteShareLink.push(args.id);
        const index = links.findIndex((link) => link.id === args.id);
        if (index === -1) {
          throw refuse('Share link not found.', 'NOT_FOUND');
        }
        links.splice(index, 1);
        return true;
      },
      rekeyDocument: (_parent: unknown, args: { id: string }) => {
        calls.rekeyDocument.push(args.id);
        if (options.rekeyRefusal) {
          throw refuse(options.rekeyRefusal, 'STORAGE_ERROR');
        }
        const document = documents.find((entry) => entry.id === args.id);
        if (document === undefined) {
          throw refuse('Document not found.', 'NOT_FOUND');
        }
        document.objectKey = `${clientId()}-${document.filename}`;
        for (const link of links) {
          if (link.documentId === document.id) {
            link.state = 'revoked';
          }
        }
        return document;
      },
      updateAppSettings: (_parent: unknown, args: { input: Partial<AppSettingsFixture> }) => {
        calls.updateAppSettings.push(args.input);
        if (options.updateRefusal) {
          throw refuse(options.updateRefusal, 'BAD_USER_INPUT');
        }
        const sent = Object.fromEntries(Object.entries(args.input).filter(([, value]) => value != null));
        Object.assign(settings, sent);
        return settings;
      },
    },
  };

  return { resolvers, links, settings, calls };
}

/** A map of resolvers by type, as a mock server takes it. */
type ResolverMap = Record<string, Record<string, unknown>>;

/**
 * Lays several servers' resolvers over each other, type by type, the later winning a field both answer.
 *
 * @param maps - The servers' resolvers.
 * @returns One map.
 */
export function mergeResolvers(...maps: ResolverMap[]): ResolverMap {
  const merged: ResolverMap = {};
  for (const map of maps) {
    for (const [type, fields] of Object.entries(map)) {
      merged[type] = { ...merged[type], ...fields };
    }
  }
  return merged;
}

/**
 * The buckets and documents of `documentServer` with the share links and settings of `shareLinkServer` over them,
 * sharing one list of documents, so a re-key moves the document the page shows.
 *
 * @param documents - The documents it starts with.
 * @param links - The share links it starts with, newest first.
 * @param options - How the share-link half answers.
 * @returns Both servers and their resolvers merged.
 */
export function sharingServer(
  documents: readonly DocumentFixture[],
  links: readonly ShareLinkFixture[] = [],
  options: ShareLinkServerOptions = {},
) {
  const library = documentServer([MINIO_BUCKET, S3_BUCKET], documents);
  const sharing = shareLinkServer(library.documents, links, options);
  return { library, sharing, resolvers: mergeResolvers(library.resolvers, sharing.resolvers) };
}
