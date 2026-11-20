import { useState } from 'react';
import { ComboboxField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { messageOf } from '@/lib/error-message';
import { type TagChipData, tagOptions } from '@/lib/tags';

/** The tags to put on, and to take off, by id. */
interface BulkTagChange {
  add: string[];
  remove: string[];
}

interface BulkTagDialogProps {
  /** How many documents are chosen, for the title. */
  count: number;
  /** Every tag of the owner's. */
  tags: readonly TagChipData[];
  /** Puts `add` on every chosen document and takes `remove` off, in one go. The dialog closes once this resolves. */
  onSave: (change: BulkTagChange) => Promise<unknown>;
  /** Called when the dialog should go away: saved, cancelled or dismissed. */
  onClose: () => void;
}

/**
 * What is wrong with a bulk change as chosen.
 *
 * @param add - The tags to put on.
 * @param remove - The tags to take off.
 * @returns The problem, or undefined when there is none.
 */
export function bulkTagError(add: readonly string[], remove: readonly string[]): string | undefined {
  if (add.length === 0 && remove.length === 0) {
    return 'Choose a tag to add or to remove';
  }
  const removing = new Set(remove);
  return add.some((id) => removing.has(id)) ? 'A tag cannot be added and removed at once' : undefined;
}

/**
 * Tagging the documents chosen in the list at once: tags to add and tags to remove, saved in one go. A document that
 * already has a tag being added keeps it once, and one without a tag being removed is left as it is.
 *
 * @param props - How many are chosen, the tags, what saves and what closes.
 * @returns The dialog.
 */
export function BulkTagDialog({ count, tags, onSave, onClose }: BulkTagDialogProps) {
  const [refusal, setRefusal] = useState<string | undefined>();
  const options = tagOptions(tags);
  const nothing: BulkTagChange = { add: [], remove: [] };
  const form = useAppForm({
    defaultValues: nothing,
    onSubmit: async ({ value }) => {
      setRefusal(undefined);
      try {
        await onSave({ add: [...value.add], remove: [...value.remove] });
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
        title={count === 1 ? 'Tag 1 document' : `Tag ${count} documents`}
        description="The tags you add go on every one of them, and the tags you remove come off every one."
        hasUnsavedChanges={() => form.state.isDefaultValue === false}
        contentSlot={
          <FormElement className="grid gap-4" onSubmit={() => form.handleSubmit()}>
            <ComboboxField
              form={form}
              name="add"
              label="Add"
              multiple
              options={options}
              placeholder="No tags to add"
              popoverLabel="Tags to add"
              searchLabel="Find a tag to add"
              emptyMessage="No tag has that name. Make it on the Tags page."
              validators={{
                onSubmit: ({ value, fieldApi }) => bulkTagError(value ?? [], fieldApi.form.getFieldValue('remove')),
              }}
            />
            <ComboboxField
              form={form}
              name="remove"
              label="Remove"
              multiple
              options={options}
              placeholder="No tags to remove"
              popoverLabel="Tags to remove"
              searchLabel="Find a tag to remove"
              emptyMessage="No tag has that name."
            />
            {refusal && <Alert variant="destructive" title="Could not tag them" description={refusal} />}
          </FormElement>
        }
        footerActionsSlot={(close) => (
          <>
            <Button variant="outline" content="Cancel" onClick={close} />
            <form.SubmitButton createLabel="Apply" />
          </>
        )}
      />
    </form.AppForm>
  );
}
