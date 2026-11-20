import { useMutation } from '@apollo/client/react';
import { useState } from 'react';
import { graphql } from '@/__generated__';
import { PasswordField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { messageOf } from '@/lib/error-message';

const SetBucketSecret = graphql(`
  mutation SetBucketSecret($id: UUID!, $secretAccessKey: String!) {
    setBucketSecret(id: $id, secretAccessKey: $secretAccessKey) {
      id
      secretReadable
    }
  }
`);

/** What the dialog needs to know about the bucket whose secret is being entered again. */
export interface SecretBucket {
  id: string;
  name: string;
  accessKeyId: string;
}

interface BucketSecretDialogProps {
  bucket: SecretBucket;
  /** Refetches the list once the secret is saved. */
  onSaved: () => Promise<unknown>;
  onClose: () => void;
}

/**
 * Enters a bucket's secret access key again, through `setBucketSecret`, which tests the bucket
 * with it before saving. Only the secret: every other field stays as it is stored. For a bucket
 * whose stored secret no longer opens, or one whose key was rotated at the provider.
 *
 * @param props - The bucket, and what to call once saved or closed.
 * @returns The dialog.
 */
export function BucketSecretDialog({ bucket, onSaved, onClose }: BucketSecretDialogProps) {
  const [setBucketSecret] = useMutation(SetBucketSecret);
  const [refusal, setRefusal] = useState<string | undefined>();

  const form = useAppForm({
    defaultValues: { secretAccessKey: '' },
    onSubmit: async ({ value }) => {
      setRefusal(undefined);
      try {
        await setBucketSecret({ variables: { id: bucket.id, secretAccessKey: value.secretAccessKey.trim() } });
        await onSaved();
        onClose();
      } catch (error) {
        setRefusal(messageOf(error) ?? 'The server refused it');
      }
    },
  });

  return (
    <DialogLayout
      open
      onOpenChange={(open) => {
        if (open === false) {
          onClose();
        }
      }}
      title={`Secret for “${bucket.name}”`}
      description={`The secret access key that goes with key ${bucket.accessKeyId}. The bucket is tested with it before it is saved.`}
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
          <PasswordField
            form={form}
            name="secretAccessKey"
            label="Secret access key"
            required
            autoFocus
            autoComplete="new-password"
            validators={{
              onSubmit: ({ value }) => (value.trim() === '' ? 'Enter the secret access key' : undefined),
            }}
          />
          {refusal && <Alert variant="destructive" title="Could not save the secret" description={refusal} />}
        </div>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" content="Cancel" onClick={close} />
          <form.SubmitButton createLabel="Save secret" loadingLabel="Testing and saving…" />
        </>
      )}
    />
  );
}
