import { useState } from 'react';
import { DialogLayout } from '@/components/dialog-layout';
import { type UploadBucket, UploadPanel } from '@/components/domain/upload-panel';
import { Button } from '@/components/ui/button';

interface UploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every bucket, for the panel's picker. */
  buckets: readonly UploadBucket[];
  /** The bucket the page is filtered to, which the picker starts on. */
  preferredSlug?: string | null | undefined;
  /** Called once a batch has landed, so the lists refetch. */
  onUploaded: () => void;
}

/**
 * The upload panel in a dialog. Closing it while files are still waiting or being sent asks
 * first, because closing stops them.
 *
 * @param props - Whether it is open, the buckets, and who hears about finished uploads.
 * @returns The dialog.
 */
export function UploadDialog({ open, onOpenChange, buckets, preferredSlug, onUploaded }: UploadDialogProps) {
  const [busy, setBusy] = useState(false);

  return (
    <DialogLayout
      open={open}
      onOpenChange={(next) => {
        if (next === false) {
          setBusy(false);
        }
        onOpenChange(next);
      }}
      size="lg"
      title="Upload documents"
      description="Pick a bucket, then drop files or a folder. Each file is uploaded on its own, a few at a time."
      hasUnsavedChanges={busy}
      discardTitle="Stop the uploads?"
      discardDescription="Files still waiting or being sent are not uploaded. The ones already uploaded stay."
      discardLabel="Stop uploads"
      keepLabel="Keep uploading"
      // The footer's Close is the way out, and it asks first the same way.
      showCloseButton={false}
      contentSlot={
        <UploadPanel buckets={buckets} preferredSlug={preferredSlug} onUploaded={onUploaded} onBusyChange={setBusy} />
      }
      footerActionsSlot={(close) => <Button variant="outline" content="Close" onClick={close} />}
    />
  );
}
