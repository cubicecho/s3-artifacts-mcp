import { useMutation } from '@apollo/client/react';
import { useState } from 'react';
import { graphql } from '@/__generated__';
import type { ShareLinkPermission } from '@/__generated__/graphql';
import { InputField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { LinkExpiryField } from '@/components/domain/link-expiry-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { CopyButton } from '@/components/ui/copy-button';
import { FormElement } from '@/components/ui/form-element';
import { RadioGroupField } from '@/components/ui/radio-group-field';
import { messageOf } from '@/lib/error-message';
import { formatDateTime } from '@/lib/format';
import { type ExpiryLimits, expiryError, PERMISSION_LABELS } from '@/lib/share-links';

const CreateShareLink = graphql(`
  mutation CreateShareLink(
    $documentId: UUID!
    $permission: ShareLinkPermission
    $expiresInHours: Int
    $label: String
  ) {
    createShareLink(documentId: $documentId, permission: $permission, expiresInHours: $expiresInHours, label: $label) {
      id
      url
      expiresAt
    }
  }
`);

/** The longest label the server takes. */
const LABEL_MAX_LENGTH = 100;

/** What each permission does, under its name: `view` asks for inline and is not copy protection. */
const PERMISSION_OPTIONS = [
  {
    value: 'view',
    label: PERMISSION_LABELS.view,
    description:
      'The browser shows the file where it can. This is not copy protection: anyone with the link can still save it.',
  },
  {
    value: 'download',
    label: PERMISSION_LABELS.download,
    description: 'The browser saves the file under its own name.',
  },
];

/** A permission from the radio group, which hands back a string. */
function permissionOf(value: string): ShareLinkPermission {
  return value === 'view' ? 'view' : 'download';
}

/** The form's values. The permission is the radio group's string until it is sent. */
interface ShareLinkDraft {
  permission: string;
  /** Null while a custom amount is not a whole number. */
  expiresInHours: number | null;
  label: string;
}

/** The new link, as the dialog shows it once it exists. */
interface MadeLink {
  url: string | null;
  expiresAt: string;
}

interface ShareLinkDialogProps {
  documentId: string;
  /** The document's title, for the dialog's own. */
  title: string;
  /** What the form opens on: the owner's defaults from Settings → General. */
  defaults: { permission: ShareLinkPermission; expiresInHours: number };
  /** The shortest and longest a link may last. */
  limits: ExpiryLimits;
  /** Called once the link exists, so the lists can show it. */
  onCreated: () => Promise<unknown>;
  onClose: () => void;
}

/**
 * Makes a share link in two steps: what it lets its holder do, how long it lasts and an optional label, then the
 * URL itself with a Copy button. Mounted only while open, so each opening starts from the defaults.
 *
 * @param props - The document, the defaults and limits, and what to call once the link exists and on close.
 * @returns The dialog.
 */
export function ShareLinkDialog({ documentId, title, defaults, limits, onCreated, onClose }: ShareLinkDialogProps) {
  const [made, setMade] = useState<MadeLink | null>(null);
  const [refusal, setRefusal] = useState<string | undefined>();
  const [copyFailed, setCopyFailed] = useState(false);
  const [createShareLink] = useMutation(CreateShareLink);

  const defaultValues: ShareLinkDraft = {
    permission: defaults.permission,
    expiresInHours: defaults.expiresInHours,
    label: '',
  };
  const form = useAppForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      setRefusal(undefined);
      try {
        const result = await createShareLink({
          variables: {
            documentId,
            permission: permissionOf(value.permission),
            expiresInHours: value.expiresInHours,
            label: value.label.trim() === '' ? null : value.label.trim(),
          },
        });
        const link = result.data?.createShareLink;
        if (link) {
          setMade({ url: link.url, expiresAt: link.expiresAt });
          await onCreated();
        }
      } catch (error) {
        setRefusal(messageOf(error) ?? 'The server refused it');
      }
    },
  });

  const onOpenChange = (open: boolean) => {
    if (open === false) {
      onClose();
    }
  };

  if (made !== null) {
    return (
      <DialogLayout
        open
        onOpenChange={onOpenChange}
        title="Your share link"
        description={`Anyone with it can open “${title}” until ${formatDateTime(made.expiresAt)}, straight from the bucket, without signing in.`}
        contentSlot={
          <div className="grid gap-4">
            {made.url ? (
              <CodeBlock
                title="Share link"
                content={made.url}
                wrap
                actionSlot={<CopyButton value={made.url} label="Copy share link" onError={() => setCopyFailed(true)} />}
              />
            ) : (
              <Alert variant="warning" title="The link was made, but its address cannot be shown" />
            )}
            {copyFailed && (
              <Alert
                variant="info"
                title="Copy it by hand"
                description="This browser does not let the app use the clipboard here (it needs HTTPS). Select the address above and copy it."
              />
            )}
            <p className="text-foreground/60 text-sm">
              It stays in the document’s list, where it can be copied again. It cannot be stopped on its own before it
              expires; revoking all of the document’s links does.
            </p>
          </div>
        }
        footerActionsSlot={(close) => <Button content="Done" onClick={close} />}
      />
    );
  }

  return (
    <DialogLayout
      open
      onOpenChange={onOpenChange}
      title={`Share “${title}”`}
      description="A link anyone can open without signing in, served by the bucket itself."
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      wrapperSlot={(parts, { className }) => (
        <form.AppForm>
          <FormElement onSubmit={() => form.handleSubmit()} className={className}>
            {parts}
          </FormElement>
        </form.AppForm>
      )}
      contentSlot={
        <div className="grid gap-4">
          <RadioGroupField form={form} name="permission" label="What it lets them do" options={PERMISSION_OPTIONS} />
          <LinkExpiryField
            form={form}
            name="expiresInHours"
            label="Expires after"
            limits={limits}
            validators={{ onChange: ({ value }) => expiryError(value, limits) }}
          />
          <InputField
            form={form}
            name="label"
            label="Label"
            placeholder="For the design review"
            description="Optional. Only you see it, in the list of links."
            maxLength={LABEL_MAX_LENGTH}
            autoComplete="off"
          />
          {refusal && <Alert variant="destructive" title="Could not make the link" description={refusal} />}
        </div>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" content="Cancel" onClick={close} />
          <form.SubmitButton variant="info" createLabel="Make link" loadingLabel="Making…" />
        </>
      )}
    />
  );
}
