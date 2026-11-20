import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { Alert } from '@/components/ui/alert';
import { CircleCheck, RefreshCw } from '@/components/ui/icons';
import type { BucketScanResult, BucketScanState } from '@/lib/bucket-scan';
import { formatCount } from '@/lib/format';

interface BucketScanReportProps {
  /** The bucket's name, which every line names. */
  bucketName: string;
  /** Its last scan. */
  scan: BucketScanState;
}

/**
 * The sentences under a finished scan's title: what was there already, and whether it stopped early.
 *
 * @param result - What the scan did.
 * @returns The description.
 */
function describe(result: BucketScanResult): string {
  const { imported, alreadyListed, skippedCount, truncated } = result;
  const parts: string[] = [];
  if (imported + alreadyListed + skippedCount === 0) {
    parts.push('The bucket holds no files.');
  }
  if (alreadyListed > 0) {
    parts.push(`${formatCount(alreadyListed, 'file')} ${alreadyListed === 1 ? 'was' : 'were'} listed already.`);
  }
  if (truncated) {
    parts.push('The scan stopped at its limit. Scan again to add the rest.');
  }
  return parts.join(' ');
}

/**
 * What a bucket scan is doing or did: running, refused, or how many files it added, how many were documents
 * already, and the files it could not add with why. Shown beside the control that started it.
 *
 * @param props - The bucket's name and its last scan.
 * @returns The report, or nothing before a scan.
 */
export function BucketScanReport({ bucketName, scan }: BucketScanReportProps) {
  if (scan.running) {
    return (
      <Alert
        iconSlot={<RefreshCw className="motion-safe:animate-spin" />}
        title={`Scanning “${bucketName}”…`}
        description="Looking for files that are not documents yet."
      />
    );
  }
  if (scan.failure !== undefined) {
    return <Alert variant="destructive" title={`Could not scan “${bucketName}”`} description={scan.failure} />;
  }
  const { result } = scan;
  if (result === null) {
    return null;
  }
  const hidden = result.skippedCount - result.skipped.length;

  return (
    <section aria-label={`Scan of ${bucketName}`} className="grid gap-2">
      {result.imported > 0 ? (
        <Alert
          variant="info"
          iconSlot={<CircleCheck />}
          title={`Added ${formatCount(result.imported, 'file')} from “${bucketName}”`}
          description={describe(result) || undefined}
        />
      ) : (
        <Alert title={`Nothing new in “${bucketName}”`} description={describe(result) || undefined} />
      )}
      {result.skippedCount > 0 && (
        <>
          <Alert
            variant="warning"
            title={`${formatCount(result.skippedCount, 'file')} could not be added`}
            description="Their names cannot be used as a download’s. Rename them in the bucket and scan again."
          />
          <List
            label="Files not added"
            contentSlot={[
              ...result.skipped.map((skipped) => (
                <ListItem
                  key={skipped.key}
                  title={<span className="break-all font-mono text-xs">{JSON.stringify(skipped.key)}</span>}
                  description={skipped.reason}
                />
              )),
              ...(hidden > 0 ? [<ListItem key="more" title={`And ${formatCount(hidden)} more`} />] : []),
            ]}
          />
        </>
      )}
    </section>
  );
}
