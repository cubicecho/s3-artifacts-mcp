import { useState } from 'react';
import { InputField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { messageOf } from '@/lib/error-message';

interface RenameDocumentDialogProps {
  /** The title as it stands, which the field opens on. */
  title: string;
  /** Saves the trimmed title. The dialog closes once this resolves, and says why when it rejects. */
  onRename: (title: string) => Promise<unknown>;
  /** Called when the dialog should go away: saved, cancelled or dismissed. */
  onClose: () => void;
}

/**
 * What is wrong with a title as typed. The server checks it too.
 *
 * @param title - The title.
 * @returns The problem, or undefined when there is none.
 */
export function titleError(title: string): string | undefined {
  return title.trim() === '' ? 'Give the document a title' : undefined;
}

/**
 * Renaming a document is a form in a dialog, with a Save and a Cancel, rather than the title
 * turning into an input in place. Only the title changes: the file keeps the name it was uploaded
 * as, and so does its object in the bucket. Mounted only while open, so each opening starts from
 * the title as it stands.
 *
 * @param props - The title, what saves it, and what closes the dialog.
 * @returns The dialog.
 */
export function RenameDocumentDialog({ title, onRename, onClose }: RenameDocumentDialogProps) {
  const [refusal, setRefusal] = useState<string | undefined>();
  const form = useAppForm({
    defaultValues: { title },
    onSubmit: async ({ value }) => {
      setRefusal(undefined);
      try {
        await onRename(value.title.trim());
      } catch (error) {
        setRefusal(messageOf(error) ?? 'The server refused it');
        return;
      }
      onClose();
    },
  });

  return (
    <form.AppForm>
      <DialogLayout
        open
        onOpenChange={(open) => {
          if (open === false) {
            onClose();
          }
        }}
        title="Rename document"
        description="The file keeps the name it was uploaded as, and so does its object in the bucket."
        hasUnsavedChanges={() => form.state.isDefaultValue === false}
        contentSlot={
          <FormElement className="grid gap-4" onSubmit={() => form.handleSubmit()}>
            <InputField
              form={form}
              name="title"
              label="Title"
              required
              autoFocus
              validators={{ onSubmit: ({ value }) => titleError(value) }}
            />
            {refusal && <Alert variant="destructive" title="Could not rename it" description={refusal} />}
          </FormElement>
        }
        footerActionsSlot={(close) => (
          <>
            <Button variant="outline" content="Cancel" onClick={close} />
            <form.SubmitButton requireChanges />
          </>
        )}
      />
    </form.AppForm>
  );
}
