import { useState } from 'react';
import { InputField, useAppForm } from '@/components/app-form';
import { ColorField, isHexColor, normalizeHex } from '@/components/color-field';
import { DialogLayout } from '@/components/dialog-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { TAG_DEFAULTS } from '@/defaults';
import { messageOf } from '@/lib/error-message';
import type { TagChipData } from '@/lib/tags';

/** What the form saves: a trimmed name and a `#rrggbb` colour. */
export interface TagFormValues {
  name: string;
  color: string;
}

interface TagFormDialogProps {
  /** The tag being edited, or null for a new one. */
  tag: TagChipData | null;
  /** Saves the tag. The dialog closes once this resolves, and says why when it rejects. */
  onSave: (values: TagFormValues) => Promise<unknown>;
  /** Called when the dialog should go away: saved, cancelled or dismissed. */
  onClose: () => void;
}

/**
 * What is wrong with a tag's name as typed. The server checks it too, and is the one that knows the names taken.
 *
 * @param name - The name.
 * @returns The problem, or undefined when there is none.
 */
export function tagNameError(name: string): string | undefined {
  return name.trim() === '' ? 'Give the tag a name' : undefined;
}

/**
 * What is wrong with a colour as typed.
 *
 * @param color - The colour, as the hex box or a swatch left it.
 * @returns The problem, or undefined when there is none.
 */
export function tagColorError(color: string): string | undefined {
  return isHexColor(normalizeHex(color)) ? undefined : 'Pick a swatch, or type a colour such as #3b82f6';
}

/**
 * Making a tag, or renaming and recolouring one, as a form in a dialog with a Save and a Cancel. A name the owner
 * already has, in any case, is refused by the server and said under the form. Mounted only while open, so each
 * opening starts from the tag as it stands.
 *
 * @param props - The tag, what saves it, and what closes the dialog.
 * @returns The dialog.
 */
export function TagFormDialog({ tag, onSave, onClose }: TagFormDialogProps) {
  const [refusal, setRefusal] = useState<string | undefined>();
  const isNew = tag === null;
  const form = useAppForm({
    defaultValues: { name: tag?.name ?? '', color: tag?.color ?? TAG_DEFAULTS.newTagColor },
    onSubmit: async ({ value }) => {
      setRefusal(undefined);
      try {
        await onSave({ name: value.name.trim(), color: normalizeHex(value.color).toLowerCase() });
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
        title={isNew ? 'New tag' : 'Edit tag'}
        description={
          isNew
            ? 'Names are yours across every bucket, and unique ignoring case.'
            : 'Every document with the tag keeps it under its new name and colour.'
        }
        hasUnsavedChanges={() => form.state.isDefaultValue === false}
        contentSlot={
          <FormElement className="grid gap-4" onSubmit={() => form.handleSubmit()}>
            <InputField
              form={form}
              name="name"
              label="Name"
              required
              autoFocus
              validators={{ onSubmit: ({ value }) => tagNameError(value) }}
            />
            <ColorField
              form={form}
              name="color"
              label="Colour"
              validators={{ onSubmit: ({ value }) => tagColorError(value ?? '') }}
            />
            {refusal && (
              <Alert
                variant="destructive"
                title={isNew ? 'Could not make the tag' : 'Could not save the tag'}
                description={refusal}
              />
            )}
          </FormElement>
        }
        footerActionsSlot={(close) => (
          <>
            <Button variant="outline" content="Cancel" onClick={close} />
            <form.SubmitButton isEdit={isNew === false} requireChanges={isNew === false} createLabel="Make tag" />
          </>
        )}
      />
    </form.AppForm>
  );
}
