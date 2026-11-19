import { Link } from 'react-router';
import { Database } from '@/components/domain/app-icons';
import { EmptyState } from '@/components/empty-state';
import { PageLayout } from '@/components/page-layout';
import { Button } from '@/components/ui/button';
import { FileText, Settings } from '@/components/ui/icons';
import { FULL_WIDTH_BODY } from '@/lib/page';
import { ROUTES } from '@/lib/routes';

/**
 * The documents, across every bucket. Until a bucket is set up there is nowhere to upload to, so
 * the page says so and points at Settings, where buckets are added.
 *
 * @returns The documents page.
 */
export function DocumentsRoute() {
  return (
    <PageLayout
      width="full"
      iconSlot={<FileText />}
      title="Documents"
      description="Everything you have uploaded, in every bucket."
      contentClassName={FULL_WIDTH_BODY}
      contentSlot={
        <EmptyState
          level={2}
          iconSlot={<Database />}
          title="No buckets yet"
          description="Documents are stored in an S3, MinIO or RustFS bucket. Add one in Settings to start uploading."
          actionSlot={
            <Button iconSlot={<Settings />} content="Open Settings" linkSlot={<Link to={ROUTES.settings} />} />
          }
        />
      }
    />
  );
}
