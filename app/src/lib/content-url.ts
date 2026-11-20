import type { ApolloClient } from '@apollo/client';
import { useApolloClient } from '@apollo/client/react';
import { useCallback, useEffect, useState } from 'react';
import { graphql } from '@/__generated__';

/**
 * A document's bytes as a same-origin URL with a short-lived token in it, so an `<img>`, an
 * `<iframe>` or a download link can open it without the bearer header. It expires after about a
 * quarter of an hour, so it is asked for when it is about to be used and never cached.
 */
const DocumentContentUrl = graphql(`
  query DocumentContentUrl($id: UUID!, $download: Boolean) {
    document(where: { id: { eq: $id } }) {
      id
      contentUrl(download: $download)
    }
  }
`);

/**
 * Asks the server for a fresh URL to a document's bytes.
 *
 * @param client - The Apollo client.
 * @param id - The document's id.
 * @param download - Whether the URL answers as an attachment, so the browser saves it.
 * @returns The URL.
 */
export async function fetchContentUrl(client: ApolloClient, id: string, download: boolean): Promise<string> {
  const { data } = await client.query({
    query: DocumentContentUrl,
    variables: { id, download },
    fetchPolicy: 'network-only',
  });
  const url = data?.document?.contentUrl;
  if (!url) {
    throw new Error('The server gave no address for the file');
  }
  return url;
}

/** A document's preview URL, while it is fetched, after it arrived, or after it failed to. */
export interface ContentUrlState {
  /** The URL, or null while it is fetched and after it failed. Never one left from another document or ask. */
  url: string | null;
  /** The server gave no URL. */
  failed: boolean;
  /** Asks for a fresh one: after the old one expired, or after a failure. */
  refresh: () => void;
  /**
   * How many times it has been asked for. A player keyed by it starts over on a refresh, even
   * when the server hands back the same URL.
   */
  version: number;
}

/**
 * A URL to show a document's bytes in place, asked for when the page opens and again on `refresh`.
 *
 * @param id - The document's id.
 * @param enabled - Whether there is anything to show; off, nothing is asked.
 * @returns The URL's state.
 */
export function useContentUrl(id: string, enabled: boolean): ContentUrlState {
  const client = useApolloClient();
  // Kept with what it answers, so a refresh shows nothing until its own answer is in.
  const [answer, setAnswer] = useState<{ id: string; attempt: number; url: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setFailed(false);
    setAnswer(null);
    if (enabled === false) {
      return;
    }
    let current = true;
    fetchContentUrl(client, id, false).then(
      (url) => {
        if (current) {
          setAnswer({ id, attempt, url });
        }
      },
      () => {
        if (current) {
          setFailed(true);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [client, id, enabled, attempt]);

  const refresh = useCallback(() => setAttempt((count) => count + 1), []);
  const isCurrent = answer?.id === id && answer.attempt === attempt;
  return { url: isCurrent ? answer.url : null, failed, refresh, version: attempt };
}

/** A text preview the server would not hand over, with the status it answered. */
export class ContentFetchError extends Error {
  readonly status: number;

  /**
   * @param status - The HTTP status.
   */
  constructor(status: number) {
    super(`The server would not hand over the file (HTTP ${status})`);
    this.name = 'ContentFetchError';
    this.status = status;
  }
}

/**
 * Fetches a text document's bytes from its content URL. The URL carries its own token, so no
 * header is sent.
 *
 * @param url - The content URL.
 * @param signal - Aborts the fetch, when the page moves on.
 * @returns The text, decoded as UTF-8.
 */
export async function fetchContentText(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (response.ok === false) {
    throw new ContentFetchError(response.status);
  }
  return response.text();
}
