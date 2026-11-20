import { Link } from 'react-router';
import { Database } from '@/components/domain/app-icons';
import { EmptyState } from '@/components/empty-state';
import { PageLayout } from '@/components/page-layout';
import { Button } from '@/components/ui/button';
import { FileText, Plus } from '@/components/ui/icons';
import { FULL_WIDTH_BODY } from '@/lib/page';
import { settingsLink } from '@/routes/settings';

/**
 * The documents, across every bucket. Until a bucket is set up there is nowhere to upload to, so
 * the page says so and links to Settings → Buckets, where they are added.
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
          description="Documents are stored in buckets of your own: AWS S3, MinIO, RustFS or Backblaze B2, on as many accounts as you like. Add the first one to start uploading."
          actionSlot={
            <Button iconSlot={<Plus />} content="Add a bucket" linkSlot={<Link to={settingsLink('buckets')} />} />
          }
        />
      }
    />
  );
}
