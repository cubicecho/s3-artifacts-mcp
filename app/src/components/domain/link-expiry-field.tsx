import { useState } from 'react';
import { bindToForm, type FieldProps, splitProps, useFieldContext, useFieldError } from '@/components/app-form';
import { Combobox } from '@/components/combobox';
import { FormField } from '@/components/form-field';
import { Input } from '@/components/ui/input';
import { SegmentedButton, SegmentedGroup } from '@/components/ui/segmented';
import { MS_PER_HOUR } from '@/consts';
import { SHARE_LINK_DEFAULTS } from '@/defaults';
import { formatDateTime } from '@/lib/format';
import { describeExpiry, type ExpiryLimits, ExpiryUnit, hoursOf, splitHours } from '@/lib/share-links';

/** The pill that opens the custom amount, beside the presets. */
const CUSTOM = 'custom';

const UNIT_OPTIONS = [
  { value: ExpiryUnit.Hours, label: 'Hours' },
  { value: ExpiryUnit.Days, label: 'Days' },
];

/**
 * Reads a typed amount.
 *
 * @param text - What is in the box.
 * @returns The number, or null when the box is empty or holds no number.
 */
function amountOf(text: string): number | null {
  const amount = Number(text);
  return text.trim() === '' || Number.isNaN(amount) ? null : amount;
}

interface LinkExpiryPickerProps {
  /** The lifetime in hours, or null while the custom amount is not a whole number. */
  value: number | null;
  /** Told the new lifetime in hours, or null for a custom amount that is not a whole number. */
  onValueChange: (hours: number | null) => void;
  /** The shortest and longest the server allows. */
  limits: ExpiryLimits;
  /** The id of the title that names the choice. */
  'aria-labelledby'?: string | undefined;
  /** The field's description and error. */
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: true | undefined;
  disabled?: boolean | undefined;
}

/**
 * How long a share link lasts: a pill for each preset the server's limits allow, or a custom number of hours
 * or days, and the moment it would stop working. Holds which pill is pressed and what is typed; the hours are
 * the caller's.
 *
 * @param props - The hours, who hears of a change, and the limits.
 * @returns The picker.
 */
export function LinkExpiryPicker({
  value,
  onValueChange,
  limits,
  disabled,
  'aria-labelledby': labelledBy,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: LinkExpiryPickerProps) {
  const presets = Object.values(SHARE_LINK_DEFAULTS.expiryPresetHours).filter(
    (hours) => hours >= limits.minLinkExpiryHours && hours <= limits.maxLinkExpiryHours,
  );
  const isPreset = value !== null && presets.includes(value);
  const [choice, setChoice] = useState(() => (isPreset ? String(value) : CUSTOM));
  const start = splitHours(value ?? limits.minLinkExpiryHours);
  const [amountText, setAmountText] = useState(String(start.amount));
  const [unit, setUnit] = useState<ExpiryUnit>(start.unit);
  const isCustom = choice === CUSTOM;

  const choose = (next: string) => {
    setChoice(next);
    onValueChange(next === CUSTOM ? hoursOf(amountOf(amountText), unit) : Number(next));
  };

  const isInRange = value !== null && value >= limits.minLinkExpiryHours && value <= limits.maxLinkExpiryHours;

  return (
    <div className="grid gap-2">
      <SegmentedGroup
        value={choice}
        onValueChange={choose}
        className="flex-wrap"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid}
      >
        {presets.map((hours) => (
          <SegmentedButton key={hours} value={String(hours)} disabled={disabled}>
            {describeExpiry(hours)}
          </SegmentedButton>
        ))}
        <SegmentedButton value={CUSTOM} disabled={disabled}>
          Custom
        </SegmentedButton>
      </SegmentedGroup>
      {isCustom && (
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="Custom expiry"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            className="w-28"
            type="number"
            inputMode="numeric"
            step={1}
            min={1}
            disabled={disabled}
            value={amountText}
            onChangeText={(text) => {
              setAmountText(text);
              onValueChange(hoursOf(amountOf(text), unit));
            }}
          />
          <Combobox
            aria-label="Custom expiry unit"
            className="w-32"
            disabled={disabled}
            options={UNIT_OPTIONS}
            value={unit}
            onValueChange={(next) => {
              const nextUnit = next === ExpiryUnit.Days ? ExpiryUnit.Days : ExpiryUnit.Hours;
              setUnit(nextUnit);
              onValueChange(hoursOf(amountOf(amountText), nextUnit));
            }}
          />
        </div>
      )}
      {isInRange && (
        <p className="text-foreground/60 text-sm" aria-live="polite">
          {`Stops working ${formatDateTime(Date.now() + value * MS_PER_HOUR)} (${describeExpiry(value)} from now)`}
        </p>
      )}
    </div>
  );
}

type LinkExpiryFieldProps = FieldProps & {
  /** The shortest and longest the server allows. */
  limits: ExpiryLimits;
};

/**
 * The picker as a form field over a number of hours, with the limit S3 sets said under it. Shared by the share
 * dialog and Settings → General's default.
 *
 * @param props - The field's label and description, and the limits.
 * @returns The field.
 */
function BoundLinkExpiryField(props: LinkExpiryFieldProps) {
  const [fieldProps, { limits }] = splitProps(props);
  const field = useFieldContext<number | null>();
  const error = useFieldError();

  return (
    <FormField
      {...fieldProps}
      asGroup
      error={error}
      description={
        fieldProps.description ??
        `${describeExpiry(limits.maxLinkExpiryHours)} is the most S3 allows: a link cannot last longer, and none lasts forever.`
      }
      controlSlot={(wired) => (
        <LinkExpiryPicker
          aria-labelledby={wired['aria-labelledby']}
          aria-describedby={wired['aria-describedby']}
          aria-invalid={wired['aria-invalid']}
          disabled={wired.disabled}
          limits={limits}
          value={field.state.value}
          onValueChange={(hours) => {
            field.handleChange(hours);
            // A press is the whole interaction, and no blur follows it to say the field was touched.
            field.handleBlur();
          }}
        />
      )}
    />
  );
}

/**
 * How long a share link lasts, as one line, over a field holding hours (`number | null`).
 *
 * ```tsx
 * <LinkExpiryField form={form} name="expiresInHours" label="Expires after" limits={limits} />
 * ```
 */
export const LinkExpiryField = bindToForm<LinkExpiryFieldProps, number | null>(BoundLinkExpiryField, 'LinkExpiryField');
