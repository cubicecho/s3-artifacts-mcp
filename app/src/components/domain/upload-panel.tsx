import { useMutation, useQuery } from '@apollo/client/react';
import { useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { graphql } from '@/__generated__';
import { Combobox } from '@/components/combobox';
import { FormField } from '@/components/form-field';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FilePicker, FilePickerButton } from '@/components/ui/file-picker';
import type { PickedFile } from '@/components/ui/file-picker-base';
import { ArrowRight, Folder, RefreshCw, X } from '@/components/ui/icons';
import { Progress } from '@/components/ui/progress';
import { UPLOAD_DEFAULTS } from '@/defaults';
import { describeError } from '@/lib/error-message';
import { formatBytes, formatCount, joinStats } from '@/lib/format';
import { clientId } from '@/lib/id';
import { lastBucketId, preselectBucket, rememberBucket } from '@/lib/last-bucket';
import { sortBuckets } from '@/lib/library';
import { documentPath } from '@/lib/routes';
import { createLimiter, flattenUpload, isAbort, UploadSendContext, uploadContentType } from '@/lib/upload';
import { describeUploadLimit, UploadLimit } from '@/lib/upload-limit';

const CreateDocumentUpload = graphql(`
  mutation CreateDocumentUpload($bucketId: UUID!, $filename: String!, $contentType: String, $size: Float!) {
    createDocumentUpload(bucketId: $bucketId, filename: $filename, contentType: $contentType, size: $size) {
      document {
        id
      }
      uploadPath
    }
  }
`);

// A job's progress is a fraction; the bar is in percent.
const PERCENT = 100;

/** Where one file's upload is. */
const JobPhase = {
  /** Waiting for a free slot: nothing has been asked of the server yet. */
  Queued: 'queued',
  Sending: 'sending',
  Done: 'done',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;
type JobPhase = (typeof JobPhase)[keyof typeof JobPhase];

/** One file in the panel's list. */
interface Job {
  key: string;
  file: PickedFile;
  /** The bucket it goes to, fixed when it was picked. */
  bucketId: string;
  progress: number;
  phase: JobPhase;
  error: string | null;
  /** The document the upload made, once the server has made it. */
  documentId: string | null;
}

/** A bucket as the picker offers it. */
export interface UploadBucket {
  id: string;
  slug: string;
  name: string;
  secretReadable: boolean;
}

interface UploadPanelProps {
  /** Every bucket, for the picker. One whose secret cannot be read is listed but cannot be chosen. */
  buckets: readonly UploadBucket[];
  /** The bucket the page is filtered to, which the picker starts on. */
  preferredSlug?: string | null | undefined;
  /** Called once the queue has drained and at least one file landed, so the lists refetch. */
  onUploaded: () => void;
  /** Told whether anything is still waiting or being sent, so a dialog can ask before closing. */
  onBusyChange?: ((busy: boolean) => void) | undefined;
}

/** What a job's row says at its end. */
function jobStatus(job: Job): string {
  switch (job.phase) {
    case JobPhase.Queued:
      return 'Waiting';
    case JobPhase.Sending:
      return `${Math.round(job.progress * PERCENT)}%`;
    case JobPhase.Done:
      return 'Uploaded';
    case JobPhase.Failed:
      return 'Failed';
    case JobPhase.Cancelled:
      return 'Cancelled';
  }
}

/** Whether a job still has work in front of it. */
function isActive(job: Job): boolean {
  return job.phase === JobPhase.Queued || job.phase === JobPhase.Sending;
}

/**
 * The bucket picker, a drop zone and a row per file: each file is created as a document in the
 * chosen bucket, then its bytes are sent to the server, which streams them on. A dropped or picked
 * folder uploads its files side by side, because a bucket has no folders. Every row has its own
 * progress bar, its own failure with a retry, and a cancel while it is waiting or being sent.
 *
 * @param props - The buckets, the one to start on, and who hears about finished uploads.
 * @returns The panel.
 */
export function UploadPanel({ buckets, preferredSlug, onUploaded, onBusyChange }: UploadPanelProps) {
  const send = useContext(UploadSendContext);
  const [createUpload] = useMutation(CreateDocumentUpload);
  // The owner's limit, from Settings → General. Until it arrives the server is the only check, as it always is.
  const maxUploadBytes = useQuery(UploadLimit).data?.appSettings?.maxUploadBytes ?? null;
  const [bucketId, setBucketId] = useState(() => preselectBucket(buckets, preferredSlug, lastBucketId()));
  const [jobs, setJobs] = useState<Job[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(0);
  // One for the panel's life, so files from separate picks share the same few slots.
  const [limit] = useState(() => createLimiter(UPLOAD_DEFAULTS.concurrency));
  const controllers = useRef(new Map<string, AbortController>());
  // Cancelled while still queued: the slot it gets later is handed straight on.
  const cancelled = useRef(new Set<string>());
  const landed = useRef(0);
  // Set once the panel is gone, so a file still queued behind the limiter is never started.
  const closed = useRef(false);

  const busy = jobs.some(isActive);
  useEffect(() => {
    onBusyChange?.(busy);
    if (busy === false && landed.current > 0) {
      landed.current = 0;
      onUploaded();
    }
  }, [busy, onBusyChange, onUploaded]);

  // Closing the panel stops what it started: nothing would be left to show the outcome.
  useEffect(() => {
    closed.current = false;
    const running = controllers.current;
    return () => {
      closed.current = true;
      for (const controller of running.values()) {
        controller.abort();
      }
    };
  }, []);

  const update = (key: string, patch: Partial<Job>) =>
    setJobs((current) => current.map((job) => (job.key === key ? { ...job, ...patch } : job)));

  async function uploadOne(job: Job) {
    if (closed.current || cancelled.current.has(job.key)) {
      return;
    }
    const controller = new AbortController();
    controllers.current.set(job.key, controller);
    update(job.key, { phase: JobPhase.Sending, progress: 0, error: null });
    try {
      const { file } = job;
      // `read="none"` hands back the browser's own handle, so a large file is streamed and never held.
      if (!file.blob) {
        throw new Error('The browser did not hand over the file');
      }
      const contentType = uploadContentType(file);
      const { data } = await createUpload({
        variables: { bucketId: job.bucketId, filename: file.name, contentType, size: file.size },
      });
      if (!data) {
        throw new Error('The server did not answer');
      }
      const { document, uploadPath } = data.createDocumentUpload;
      update(job.key, { documentId: document.id });
      if (controller.signal.aborted) {
        throw new DOMException('Upload cancelled', 'AbortError');
      }
      await send({
        path: uploadPath,
        file: file.blob,
        contentType,
        onProgress: (progress) => update(job.key, { progress }),
        signal: controller.signal,
      });
      landed.current += 1;
      update(job.key, { phase: JobPhase.Done, progress: 1 });
    } catch (error) {
      update(
        job.key,
        isAbort(error) ? { phase: JobPhase.Cancelled } : { phase: JobPhase.Failed, error: describeError(error) },
      );
    } finally {
      controllers.current.delete(job.key);
    }
  }

  function enqueue(job: Job) {
    cancelled.current.delete(job.key);
    void limit(() => uploadOne(job));
  }

  function start(picked: PickedFile[]) {
    const flat = flattenUpload(picked);
    setSkipped(flat.skipped);
    if (bucketId === null) {
      setNotice('Choose a bucket to upload into first, then add the files again.');
      return;
    }
    setNotice(null);
    rememberBucket(bucketId);
    const added = flat.files.map((file): Job => {
      // Refused here rather than sent to be refused: the server checks the same limit again.
      const isTooLarge = maxUploadBytes !== null && file.size > maxUploadBytes;
      return {
        key: clientId(),
        file,
        bucketId,
        progress: 0,
        phase: isTooLarge ? JobPhase.Failed : JobPhase.Queued,
        error: isTooLarge ? `Larger than the ${describeUploadLimit(maxUploadBytes)} upload limit` : null,
        documentId: null,
      };
    });
    // Newest first, and the finished ones from an earlier pick cleared away.
    setJobs((current) => [...added, ...current.filter((job) => job.phase !== JobPhase.Done)]);
    for (const job of added.filter((entry) => entry.phase === JobPhase.Queued)) {
      enqueue(job);
    }
  }

  function cancel(job: Job) {
    const controller = controllers.current.get(job.key);
    if (controller) {
      controller.abort();
      return;
    }
    cancelled.current.add(job.key);
    update(job.key, { phase: JobPhase.Cancelled });
  }

  function retry(job: Job) {
    const fresh: Job = { ...job, phase: JobPhase.Queued, progress: 0, error: null, documentId: null };
    update(job.key, fresh);
    enqueue(fresh);
  }

  const dismiss = (job: Job) => setJobs((current) => current.filter((entry) => entry.key !== job.key));

  const sorted = sortBuckets(buckets);
  const bucketName = (id: string) => buckets.find((bucket) => bucket.id === id)?.name ?? 'a removed bucket';

  return (
    <div className="grid gap-4">
      <FormField
        label="Upload into"
        description="Every file goes into this bucket. A bucket whose secret cannot be read takes nothing until it is re-entered in Settings → Buckets."
        required
        controlSlot={(props) => (
          <Combobox
            {...props}
            options={sorted.map((bucket) => ({
              value: bucket.id,
              // The reason is in the label: a plain select draws no hint, and a greyed row alone reads as a bug.
              label: bucket.secretReadable ? bucket.name : `${bucket.name} (secret unreadable)`,
              disabled: bucket.secretReadable === false,
            }))}
            value={bucketId ?? undefined}
            onValueChange={setBucketId}
            placeholder="Choose a bucket"
          />
        )}
      />

      <FilePicker
        label="Drop files or a folder here, or click to choose"
        hint={
          maxUploadBytes === null
            ? "A folder's files are uploaded side by side: a bucket has no folders."
            : `Up to ${describeUploadLimit(maxUploadBytes)} a file. A folder's files are uploaded side by side: a bucket has no folders.`
        }
        multiple
        read="none"
        onPickMany={start}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <FilePickerButton
          variant="outline"
          size="sm"
          label="Upload a folder"
          iconSlot={<Folder />}
          directory
          read="none"
          onPickMany={start}
        />
      </div>

      {notice && <Alert variant="warning" title="No bucket chosen" description={notice} />}

      {skipped > 0 && (
        <Alert
          variant="info"
          title={`${formatCount(skipped, 'file')} left out`}
          description="System files a desktop or a NAS keeps beside the others, such as .DS_Store and Thumbs.db, are not uploaded."
        />
      )}

      <List
        label="Uploads"
        divided={false}
        contentSlot={jobs.map((job) => (
          <div key={job.key} className="flex flex-col gap-1">
            <ListItem
              className="px-0"
              title={job.file.name}
              description={joinStats(formatBytes(job.file.size), bucketName(job.bucketId))}
              meta={jobStatus(job)}
              actionSlot={<JobActions job={job} onCancel={cancel} onRetry={retry} onDismiss={dismiss} />}
            />
            <Progress value={job.progress * PERCENT} label={`${job.file.name} upload progress`} />
            {job.error && <p className="text-negative text-xs">{job.error}</p>}
          </div>
        ))}
      />
    </div>
  );
}

interface JobActionsProps {
  job: Job;
  onCancel: (job: Job) => void;
  onRetry: (job: Job) => void;
  onDismiss: (job: Job) => void;
}

/**
 * A job row's buttons: cancel while it is waiting or being sent, retry once it failed or was
 * cancelled, and open or dismiss once it is over.
 *
 * @param props - The job, and what each button does.
 * @returns The buttons.
 */
function JobActions({ job, onCancel, onRetry, onDismiss }: JobActionsProps) {
  const name = job.file.name;
  if (isActive(job)) {
    return (
      <Button
        aria-label={`Cancel ${name}`}
        variant="outline"
        size="icon-xs"
        iconSlot={<X />}
        onClick={() => onCancel(job)}
      />
    );
  }
  const dismiss = (
    <Button
      aria-label={`Dismiss ${name}`}
      variant="outline"
      size="icon-xs"
      iconSlot={<X />}
      onClick={() => onDismiss(job)}
    />
  );
  if (job.phase === JobPhase.Done) {
    return (
      <>
        {job.documentId && (
          <Button
            aria-label={`Open ${name}`}
            variant="outline"
            size="icon-xs"
            iconSlot={<ArrowRight />}
            linkSlot={<Link to={documentPath(job.documentId)} />}
          />
        )}
        {dismiss}
      </>
    );
  }
  return (
    <>
      <Button
        aria-label={`Retry ${name}`}
        variant="outline"
        size="icon-xs"
        iconSlot={<RefreshCw />}
        onClick={() => onRetry(job)}
      />
      {dismiss}
    </>
  );
}
