import { useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';
import { graphql } from '@/__generated__';
import type { BucketInput, BucketPresetsQuery, BucketUpdateInput } from '@/__generated__/graphql';
import { InputField, PasswordField, SelectField, SwitchField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { type BucketTestOutcome, BucketTestReport } from '@/components/domain/bucket-test-report';
import { FieldRow } from '@/components/field-row';
import { LoadError } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { PlugZap } from '@/components/ui/icons';
import { messageOf } from '@/lib/error-message';

const BucketPresets = graphql(`
  query BucketPresets {
    bucketPresets {
      provider
      label
      forcePathStyle
      defaultRegion
      endpointRequired
      regionRequired
      endpointExample
    }
  }
`);

const TestBucket = graphql(`
  mutation TestBucket($input: BucketInput!, $id: UUID) {
    testBucket(input: $input, id: $id) {
      ok
      shareLinkWarning
      steps {
        step
        ok
        skipped
        errorCode
        message
      }
    }
  }
`);

const CreateBucket = graphql(`
  mutation CreateBucket($input: BucketInput!) {
    createBucket(input: $input) {
      id
    }
  }
`);

const UpdateBucket = graphql(`
  mutation UpdateBucket($id: UUID!, $input: BucketUpdateInput!) {
    updateBucket(id: $id, input: $input) {
      id
    }
  }
`);

/** One provider's starting point for the form, as `bucketPresets` answers it. */
export type BucketPreset = BucketPresetsQuery['bucketPresets'][number];

/** A saved bucket as the form needs it: everything but the secret, which is never read back. */
export interface EditableBucket {
  id: string;
  name: string;
  slug: string;
  provider: BucketPreset['provider'];
  endpoint: string | null;
  publicEndpoint: string | null;
  region: string;
  bucket: string;
  accessKeyId: string;
  forcePathStyle: boolean;
  /** False once `BETTER_AUTH_SECRET` changed: the secret has to be typed again. */
  secretReadable: boolean;
}

/** What the form holds. Every text is a string, empty for "not given". */
interface BucketDraft {
  provider: string;
  name: string;
  slug: string;
  endpoint: string;
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** What the region field says under it, by provider, where the preset alone would not say enough. */
const REGION_HINTS: Readonly<Record<string, string>> = Object.freeze({
  s3: 'Where the bucket lives, such as eu-west-1.',
  b2: 'The part of the endpoint after “s3.”, such as us-west-004. Filled in from the endpoint.',
});

/** A Backblaze B2 S3 endpoint's host, whose second label is the region: `s3.us-west-004.backblazeb2.com`. */
const B2_ENDPOINT_HOST = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/;

/**
 * The region a Backblaze B2 endpoint names, as the server reads it too.
 *
 * @param endpoint - The endpoint as typed.
 * @returns The region (`us-west-004`), or null when it is not a B2 S3 endpoint.
 */
function regionOfB2Endpoint(endpoint: string): string | null {
  try {
    return B2_ENDPOINT_HOST.exec(new URL(endpoint.trim()).hostname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The slug the server derives from a name when none is given, shown as the slug's placeholder.
 *
 * @param name - The bucket's name as typed.
 * @returns Lowercase letters and digits joined by single hyphens.
 */
function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A text field's value as the API takes it: trimmed, and null when empty.
 *
 * @param value - The field's value.
 * @returns The trimmed text, or null.
 */
function optional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The form's values as `testBucket` and `createBucket` take them.
 *
 * @param draft - The form's values.
 * @param preset - The provider chosen, which is where the typed provider comes from.
 * @returns The input.
 */
function toInput(draft: BucketDraft, preset: BucketPreset): BucketInput {
  return {
    name: draft.name.trim(),
    slug: optional(draft.slug),
    provider: preset.provider,
    endpoint: optional(draft.endpoint),
    publicEndpoint: optional(draft.publicEndpoint),
    region: optional(draft.region),
    bucket: draft.bucket.trim(),
    accessKeyId: draft.accessKeyId.trim(),
    secretAccessKey: optional(draft.secretAccessKey),
    forcePathStyle: draft.forcePathStyle,
  };
}

/**
 * The form's values as `updateBucket` takes them. A blank secret, slug or region is left out,
 * which keeps what is stored; a blank endpoint is sent as null, which clears it.
 *
 * @param draft - The form's values.
 * @param preset - The provider chosen.
 * @returns The changes.
 */
function toUpdate(draft: BucketDraft, preset: BucketPreset): BucketUpdateInput {
  const { secretAccessKey, slug, region, ...rest } = toInput(draft, preset);
  return {
    ...rest,
    ...(slug === null ? {} : { slug }),
    ...(region === null ? {} : { region }),
    ...(secretAccessKey === null ? {} : { secretAccessKey }),
  };
}

/**
 * The form's starting values: the bucket being edited, or the first preset for a new one.
 *
 * @param bucket - The bucket being edited, if any.
 * @param preset - The preset a new bucket starts from.
 * @returns The values.
 */
function draftOf(bucket: EditableBucket | undefined, preset: BucketPreset): BucketDraft {
  if (bucket) {
    return {
      provider: bucket.provider,
      name: bucket.name,
      slug: bucket.slug,
      endpoint: bucket.endpoint ?? '',
      publicEndpoint: bucket.publicEndpoint ?? '',
      region: bucket.region,
      bucket: bucket.bucket,
      accessKeyId: bucket.accessKeyId,
      secretAccessKey: '',
      forcePathStyle: bucket.forcePathStyle,
    };
  }
  return {
    provider: preset.provider,
    name: '',
    slug: '',
    endpoint: '',
    publicEndpoint: '',
    region: preset.defaultRegion ?? '',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    forcePathStyle: preset.forcePathStyle,
  };
}

interface BucketFormDialogProps {
  /** The bucket to edit. Left out, the dialog adds a new one. */
  bucket?: EditableBucket | undefined;
  /** Called once the bucket is saved, so the list can show it. */
  onSaved: () => Promise<unknown>;
  onClose: () => void;
}

/**
 * Adds or edits a bucket. The providers come from the server's presets, so the picker follows
 * what the server supports. Mounted only while open, so each opening starts from the bucket as
 * saved.
 *
 * @param props - The bucket to edit, if any, and what to call once saved and when closed.
 * @returns The dialog: loading or failed while the presets are fetched, then the form.
 */
export function BucketFormDialog({ bucket, onSaved, onClose }: BucketFormDialogProps) {
  const presets = useQuery(BucketPresets);
  const list = presets.data?.bucketPresets ?? [];
  const title = bucket ? `Edit “${bucket.name}”` : 'Add a bucket';

  const onOpenChange = (open: boolean) => {
    if (open === false) {
      onClose();
    }
  };

  if (list.length === 0) {
    return (
      <DialogLayout
        open
        onOpenChange={onOpenChange}
        title={title}
        loading={presets.loading}
        contentSlot={
          presets.error ? (
            <LoadError error={presets.error} onRetry={presets.refetch} what="the providers" />
          ) : (
            <Alert variant="destructive" title="The server offers no providers" />
          )
        }
        footerActionsSlot={(close) => <Button variant="outline" content="Cancel" onClick={close} />}
      />
    );
  }

  return <BucketForm title={title} bucket={bucket} presets={list} onSaved={onSaved} onOpenChange={onOpenChange} />;
}

interface BucketFormProps {
  title: string;
  bucket: EditableBucket | undefined;
  /** At least one. */
  presets: readonly BucketPreset[];
  onSaved: () => Promise<unknown>;
  onOpenChange: (open: boolean) => void;
}

/**
 * The form itself, once the presets are in: it needs one to start a new bucket from.
 *
 * @param props - The title, the bucket to edit, the presets, and the dialog's callbacks.
 * @returns The dialog with the form in it.
 */
function BucketForm({ title, bucket, presets, onSaved, onOpenChange }: BucketFormProps) {
  const [testBucket, testing] = useMutation(TestBucket);
  const [createBucket] = useMutation(CreateBucket);
  const [updateBucket] = useMutation(UpdateBucket);
  const [outcome, setOutcome] = useState<BucketTestOutcome | null>(null);
  const [testFailure, setTestFailure] = useState<string | undefined>();
  const [refusal, setRefusal] = useState<string | undefined>();
  const isEdit = bucket !== undefined;
  const secretNeeded = bucket === undefined || bucket.secretReadable === false;
  const [firstPreset] = presets;

  const presetOf = (provider: string): BucketPreset =>
    presets.find((preset) => preset.provider === provider) ?? firstPreset;

  const form = useAppForm({
    defaultValues: draftOf(bucket, presetOf(bucket?.provider ?? firstPreset.provider)),
    // A report on settings that have since changed would vouch for something not tested.
    listeners: {
      onChange: () => {
        setOutcome(null);
        setTestFailure(undefined);
      },
    },
    onSubmit: async ({ value }) => {
      setRefusal(undefined);
      const preset = presetOf(value.provider);
      try {
        if (bucket) {
          await updateBucket({ variables: { id: bucket.id, input: toUpdate(value, preset) } });
        } else {
          await createBucket({ variables: { input: toInput(value, preset) } });
        }
        await onSaved();
        onOpenChange(false);
      } catch (error) {
        setRefusal(messageOf(error) ?? 'The server refused it');
      }
    },
  });

  async function test() {
    setOutcome(null);
    setTestFailure(undefined);
    const values = form.state.values;
    try {
      const result = await testBucket({
        variables: { input: toInput(values, presetOf(values.provider)), id: bucket?.id ?? null },
      });
      setOutcome(result.data?.testBucket ?? null);
    } catch (error) {
      setTestFailure(messageOf(error) ?? 'The server did not answer');
    }
  }

  /**
   * Fills what the preset decides when the provider changes. A region the owner typed is kept;
   * one that was only the previous preset's default is swapped for the new one's.
   */
  function applyPreset(provider: string, previous: BucketPreset) {
    const next = presetOf(provider);
    form.setFieldValue('forcePathStyle', next.forcePathStyle);
    const region = form.getFieldValue('region').trim();
    const isPresetRegion = region === '' || region === (previous.defaultRegion ?? '');
    if (isPresetRegion) {
      form.setFieldValue('region', next.defaultRegion ?? '', { dontUpdateMeta: true });
    }
  }

  /**
   * On Backblaze B2 the region is in the endpoint, so typing the endpoint fills it, until the
   * owner types a region of their own.
   */
  function fillRegionFrom(endpoint: string) {
    const region = regionOfB2Endpoint(endpoint);
    // `isDirty`, not `isTouched`: the field is marked touched without being typed in.
    const isOwnersRegion = form.state.fieldMeta.region?.isDirty === true;
    if (region === null || isOwnersRegion) {
      return;
    }
    form.setFieldValue('region', region, { dontUpdateMeta: true });
  }

  return (
    <DialogLayout
      open
      onOpenChange={onOpenChange}
      size="lg"
      title={title}
      description="Any S3-compatible bucket, on any account. Each bucket keeps its own endpoint and keys."
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
          {bucket?.secretReadable === false && (
            <Alert
              variant="warning"
              title="Enter the secret again"
              description="The stored secret can no longer be read, because the instance's BETTER_AUTH_SECRET changed. The bucket is unusable until it is entered again."
            />
          )}
          {/* The provider decides what is required, and the name and endpoint are other fields'
              placeholders, so these re-render as those values change. */}
          <form.Subscribe
            selector={(state) =>
              [state.values.provider, state.values.name, state.values.endpoint, state.values.accessKeyId] as const
            }
          >
            {([provider, name, endpoint, accessKeyId]) => {
              const preset = presetOf(provider);
              // A share link is signed with the access key, so a link made with the old one stops opening.
              const isNewAccessKey = isEdit && accessKeyId.trim() !== bucket.accessKeyId;
              return (
                <>
                  <SelectField
                    form={form}
                    name="provider"
                    label="Provider"
                    options={presets.map((entry) => ({ value: entry.provider, label: entry.label }))}
                    description="Fills in path-style and the region. You can change either."
                    listeners={{ onChange: ({ value }) => applyPreset(value, preset) }}
                  />
                  <FieldRow
                    contentSlot={
                      <>
                        <InputField
                          form={form}
                          name="name"
                          label="Name"
                          required
                          autoFocus
                          placeholder="Reports"
                          validators={{
                            onSubmit: ({ value }) => (value.trim() === '' ? 'Give the bucket a name' : undefined),
                          }}
                        />
                        <InputField
                          form={form}
                          name="slug"
                          label="Slug"
                          placeholder={slugOf(name) || 'reports'}
                          description="Names its MCP address. Left blank, it is made from the name."
                          autoComplete="off"
                        />
                      </>
                    }
                  />
                  <InputField
                    form={form}
                    name="endpoint"
                    label="Endpoint"
                    type="url"
                    listeners={{ onChange: ({ value }) => fillRegionFrom(value) }}
                    required={preset.endpointRequired}
                    placeholder={preset.endpointExample ?? undefined}
                    description={
                      preset.endpointRequired
                        ? 'The address this server reaches it at.'
                        : 'Leave blank for the regional default.'
                    }
                    autoComplete="off"
                    validators={{
                      onSubmit: ({ value, fieldApi }) => {
                        const isMissing =
                          presetOf(fieldApi.form.getFieldValue('provider')).endpointRequired && value.trim() === '';
                        return isMissing ? 'This provider needs an endpoint' : undefined;
                      },
                    }}
                  />
                  <InputField
                    form={form}
                    name="publicEndpoint"
                    label="Public endpoint"
                    type="url"
                    placeholder={endpoint.trim() || 'Same as the endpoint'}
                    description="Share links are signed for this address, so it has to be one a browser can reach. Leave blank to use the endpoint."
                    autoComplete="off"
                  />
                  <FieldRow
                    contentSlot={
                      <>
                        <InputField
                          form={form}
                          name="region"
                          label="Region"
                          required={preset.regionRequired}
                          placeholder={preset.defaultRegion ?? undefined}
                          description={REGION_HINTS[preset.provider]}
                          autoComplete="off"
                          validators={{
                            onSubmit: ({ value, fieldApi }) => {
                              const isMissing =
                                presetOf(fieldApi.form.getFieldValue('provider')).regionRequired && value.trim() === '';
                              return isMissing ? 'This provider needs a region' : undefined;
                            },
                          }}
                        />
                        <InputField
                          form={form}
                          name="bucket"
                          label="Bucket"
                          required
                          placeholder="my-reports"
                          description="Its name at the provider."
                          autoComplete="off"
                          validators={{
                            onSubmit: ({ value }) => (value.trim() === '' ? 'Name the bucket' : undefined),
                          }}
                        />
                      </>
                    }
                  />
                  <FieldRow
                    contentSlot={
                      <>
                        <InputField
                          form={form}
                          name="accessKeyId"
                          label="Access key ID"
                          required
                          autoComplete="off"
                          validators={{
                            onSubmit: ({ value }) => (value.trim() === '' ? 'Enter the access key ID' : undefined),
                          }}
                        />
                        <PasswordField
                          form={form}
                          name="secretAccessKey"
                          label="Secret access key"
                          required={secretNeeded}
                          autoComplete="new-password"
                          description={
                            secretNeeded
                              ? 'Stored encrypted, and never shown again.'
                              : 'Leave blank to keep the current secret.'
                          }
                          validators={{
                            onSubmit: ({ value }) =>
                              secretNeeded && value.trim() === '' ? 'Enter the secret access key' : undefined,
                          }}
                        />
                      </>
                    }
                  />
                  {isNewAccessKey && (
                    <Alert
                      variant="warning"
                      title="Existing share links will stop working"
                      description="Every share link of this bucket's documents was signed with the old access key, so none of them opens once the key changes. Make new links after saving."
                    />
                  )}
                </>
              );
            }}
          </form.Subscribe>
          <SwitchField
            form={form}
            name="forcePathStyle"
            label="Path-style addressing"
            description="Addresses the bucket as host/bucket rather than bucket.host. MinIO and RustFS need it."
          />
          {testFailure && <Alert variant="destructive" title="Could not run the test" description={testFailure} />}
          {outcome && <BucketTestReport outcome={outcome} />}
          {refusal && <Alert variant="destructive" title="Could not save the bucket" description={refusal} />}
        </div>
      }
      footerSlot={
        <Button
          variant="outline"
          iconSlot={<PlugZap />}
          content="Test connection"
          loading={testing.loading}
          loadingLabel="Testing…"
          onClick={() => void test()}
        />
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" content="Cancel" onClick={close} />
          <form.SubmitButton
            isEdit={isEdit}
            createLabel="Add bucket"
            loadingLabel="Testing and saving…"
            requireChanges={isEdit}
          />
        </>
      )}
    />
  );
}
