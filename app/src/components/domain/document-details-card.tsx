import { Link } from 'react-router';
import { CardLayout } from '@/components/card-layout';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { CopyButton } from '@/components/ui/copy-button';
import { formatAgo, formatBytes, formatCount, formatDateTime } from '@/lib/format';
import { bucketDocumentsPath } from '@/lib/routes';

/** What the card says about a document. */
export interface DetailsDocument {
  filename: string;
  contentType: string;
  size: number;
  objectKey: string;
  sha256: string | null;
  createdAt: string;
  bucket: { slug: string; name: string };
}

interface DocumentDetailsCardProps {
  document: DetailsDocument;
}

/**
 * The facts about a document that are not its content: the file it was uploaded as, where it is
 * kept, and what it hashes to.
 *
 * @param props - The document.
 * @returns The card.
 */
export function DocumentDetailsCard({ document }: DocumentDetailsCardProps) {
  return (
    <CardLayout
      level={2}
      title="Details"
      contentSlot={
        <PropertyList
          contentSlot={
            <>
              <PropertyRow label="Filename" value={document.filename} valueClassName="break-all" />
              <PropertyRow label="Type" value={document.contentType} valueClassName="font-mono text-xs" />
              <PropertyRow label="Size" value={formatBytes(document.size)} hint={formatCount(document.size, 'byte')} />
              <PropertyRow
                label="Bucket"
                value={
                  <Link
                    className="text-foreground underline underline-offset-2"
                    to={bucketDocumentsPath(document.bucket.slug)}
                  >
                    {document.bucket.name}
                  </Link>
                }
              />
              <PropertyRow
                label="Object key"
                value={document.objectKey}
                valueClassName="font-mono text-xs break-all"
                actionSlot={<CopyButton value={document.objectKey} label="Copy object key" />}
              />
              <PropertyRow
                label="SHA-256"
                value={document.sha256 ?? '—'}
                valueClassName="font-mono text-xs break-all"
                actionSlot={document.sha256 ? <CopyButton value={document.sha256} label="Copy SHA-256" /> : null}
              />
              <PropertyRow
                label="Uploaded"
                value={formatDateTime(document.createdAt)}
                hint={formatAgo(document.createdAt)}
              />
            </>
          }
        />
      }
    />
  );
}
