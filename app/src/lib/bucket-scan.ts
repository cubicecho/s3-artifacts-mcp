import { useApolloClient, useMutation } from '@apollo/client/react';
import { useCallback, useState } from 'react';
import { graphql } from '@/__generated__';
import type { ScanBucketMutation } from '@/__generated__/graphql';
import { messageOf } from '@/lib/error-message';
import { LIBRARY_QUERIES } from '@/lib/library';

const ScanBucket = graphql(`
  mutation ScanBucket($id: UUID!) {
    scanBucket(id: $id) {
      imported
      alreadyListed
      skippedCount
      skipped {
        key
        reason
      }
      truncated
    }
  }
`);

/** What a scan did, as `scanBucket` answers it. */
export type BucketScanResult = ScanBucketMutation['scanBucket'];

/** One bucket's last scan: running, what it did, or why it could not run. */
export interface BucketScanState {
  running: boolean;
  result: BucketScanResult | null;
  failure: string | undefined;
}

/** What `useBucketScan` hands back. */
export interface BucketScans {
  /** Each bucket's last scan here, by bucket id. */
  scans: Readonly<Record<string, BucketScanState>>;
  /** Scans one bucket, and refreshes the library when it is done. */
  scan: (bucketId: string) => Promise<void>;
}

/**
 * Scans buckets for the files already in them, keeping each bucket's last outcome to report beside the control
 * that started it.
 *
 * @returns The outcomes, and the function that starts a scan.
 *
 * @remarks
 * The library is refetched after every scan, a refused one too: a scan that fails part way keeps what it added.
 */
export function useBucketScan(): BucketScans {
  const client = useApolloClient();
  const [scanBucket] = useMutation(ScanBucket);
  const [scans, setScans] = useState<Record<string, BucketScanState>>({});

  const scan = useCallback(
    async (bucketId: string) => {
      setScans((all) => ({ ...all, [bucketId]: { running: true, result: null, failure: undefined } }));
      let next: BucketScanState = { running: false, result: null, failure: undefined };
      try {
        const { data } = await scanBucket({ variables: { id: bucketId } });
        next = { ...next, result: data?.scanBucket ?? null };
      } catch (error) {
        next = { ...next, failure: messageOf(error) ?? 'The server did not answer' };
      }
      setScans((all) => ({ ...all, [bucketId]: next }));
      await client.refetchQueries({ include: [...LIBRARY_QUERIES] });
    },
    [client, scanBucket],
  );

  return { scans, scan };
}
