import { useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';
import { graphql } from '@/__generated__';
import type { GeneralSettingsQuery, ShareLinkPermission } from '@/__generated__/graphql';
import { NumberField, useAppForm } from '@/components/app-form';
import { CardLayout } from '@/components/card-layout';
import { LinkExpiryField } from '@/components/domain/link-expiry-field';
import { LoadState } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { FormElement } from '@/components/ui/form-element';
import { RadioGroupField } from '@/components/ui/radio-group-field';
import { messageOf } from '@/lib/error-message';
import { queryLike } from '@/lib/query';
import { expiryError, PERMISSION_LABELS } from '@/lib/share-links';
import { BYTES_PER_MEBIBYTE, describeUploadLimit } from '@/lib/upload-limit';

const GeneralSettingsQueryDocument = graphql(`
  query GeneralSettings {
    appSettings {
      userId
      maxUploadBytes
      defaultLinkExpiryHours
      defaultLinkPermission
    }
    appSettingsLimits {
      minUploadBytes
      maxUploadBytes
      minLinkExpiryHours
      maxLinkExpiryHours
    }
  }
`);

const UpdateAppSettings = graphql(`
  mutation UpdateAppSettings($input: AppSettingsInput!) {
    updateAppSettings(input: $input) {
      userId
      maxUploadBytes
      defaultLinkExpiryHours
      defaultLinkPermission
    }
  }
`);

const PERMISSION_OPTIONS = [
  {
    value: 'view',
    label: PERMISSION_LABELS.view,
    description: 'Opens in the browser where it can. Not copy protection: the file can still be saved.',
  },
  { value: 'download', label: PERMISSION_LABELS.download, description: 'Saves under its own name.' },
];

/** The form's values: the upload limit in whole MiB, as it is typed. */
interface GeneralDraft {
  maxUploadMebibytes: number | null;
  defaultLinkExpiryHours: number | null;
  defaultLinkPermission: string;
}

/**
 * What is wrong with an upload limit as typed. The server checks it too.
 *
 * @param mebibytes - The limit in MiB, or null when nothing that reads as a number was typed.
 * @param limits - The smallest and largest the server allows, in bytes.
 * @returns The problem, or undefined when there is none.
 */
export function uploadLimitError(
  mebibytes: number | null,
  limits: { minUploadBytes: number; maxUploadBytes: number },
): string | undefined {
  const range = `from ${describeUploadLimit(limits.minUploadBytes)} to ${describeUploadLimit(limits.maxUploadBytes)}`;
  if (mebibytes === null || Number.isInteger(mebibytes) === false) {
    return `Enter a whole number of MiB, ${range}`;
  }
  const bytes = mebibytes * BYTES_PER_MEBIBYTE;
  return bytes < limits.minUploadBytes || bytes > limits.maxUploadBytes ? `Choose ${range}` : undefined;
}

/** A permission from the radio group, which hands back a string. */
function permissionOf(value: string): ShareLinkPermission {
  return value === 'view' ? 'view' : 'download';
}

interface GeneralSettingsFormProps {
  settings: NonNullable<GeneralSettingsQuery['appSettings']>;
  limits: GeneralSettingsQuery['appSettingsLimits'];
}

/**
 * The form itself, mounted once the settings are in, so it opens on them.
 *
 * @param props - The settings as saved, and the bounds they are checked against.
 * @returns The card with the form in it.
 */
function GeneralSettingsForm({ settings, limits }: GeneralSettingsFormProps) {
  const [updateAppSettings] = useMutation(UpdateAppSettings);
  const [refusal, setRefusal] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const defaultValues: GeneralDraft = {
    maxUploadMebibytes: settings.maxUploadBytes / BYTES_PER_MEBIBYTE,
    defaultLinkExpiryHours: settings.defaultLinkExpiryHours,
    defaultLinkPermission: settings.defaultLinkPermission,
  };
  const form = useAppForm({
    defaultValues,
    listeners: { onChange: () => setSaved(false) },
    onSubmit: async ({ value }) => {
      setRefusal(undefined);
      try {
        await updateAppSettings({
          variables: {
            input: {
              maxUploadBytes: (value.maxUploadMebibytes ?? 0) * BYTES_PER_MEBIBYTE,
              defaultLinkExpiryHours: value.defaultLinkExpiryHours,
              defaultLinkPermission: permissionOf(value.defaultLinkPermission),
            },
          },
        });
      } catch (error) {
        setRefusal(messageOf(error) ?? 'The server refused it');
        return;
      }
      // What was saved is the form's new starting point, so Save waits for the next change.
      form.reset(value);
      setSaved(true);
    },
  });

  return (
    <CardLayout
      level={2}
      title="General"
      description="The upload limit, and what a new share link gets when nobody says otherwise."
      wrapperSlot={(parts, { className }) => (
        <form.AppForm>
          <FormElement onSubmit={() => form.handleSubmit()} className={className}>
            {parts}
          </FormElement>
        </form.AppForm>
      )}
      contentSlot={
        <div className="grid gap-6">
          <NumberField
            form={form}
            name="maxUploadMebibytes"
            label="Largest upload"
            integer
            suffixText="MiB"
            className="max-w-xs"
            description={`A larger file is refused before any of it is sent. From ${describeUploadLimit(limits.minUploadBytes)} to ${describeUploadLimit(limits.maxUploadBytes)}.`}
            validators={{ onChange: ({ value }) => uploadLimitError(value, limits) }}
          />
          <LinkExpiryField
            form={form}
            name="defaultLinkExpiryHours"
            label="Default link expiry"
            limits={limits}
            validators={{ onChange: ({ value }) => expiryError(value, limits) }}
          />
          <RadioGroupField
            form={form}
            name="defaultLinkPermission"
            label="Default link permission"
            options={PERMISSION_OPTIONS}
          />
          {refusal && <Alert variant="destructive" title="Could not save the settings" description={refusal} />}
        </div>
      }
      footerActionsSlot={
        <>
          <p className="text-foreground/60 text-sm" role="status">
            {saved ? 'Saved' : ''}
          </p>
          <form.SubmitButton requireChanges />
        </>
      }
    />
  );
}

/**
 * Settings' General tab: the upload limit and the defaults a share link takes, as one form with a Save.
 *
 * @returns The card, or the load state while the settings are on their way.
 */
export function GeneralSettings() {
  const result = useQuery(GeneralSettingsQueryDocument);
  const settings = result.data?.appSettings;
  const limits = result.data?.appSettingsLimits;
  if (!settings || !limits) {
    return (
      <LoadState query={queryLike(result)} what="the general settings" record={settings} notFoundLabel="No settings" />
    );
  }
  return <GeneralSettingsForm settings={settings} limits={limits} />;
}
