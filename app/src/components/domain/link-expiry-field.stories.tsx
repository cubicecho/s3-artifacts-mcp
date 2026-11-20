import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useAppForm } from '@/components/app-form';
import { type ExpiryLimits, expiryError } from '@/lib/share-links';
import { LinkExpiryField } from './link-expiry-field';
import { LIMITS } from './share-link-fixtures';

/**
 * The expiry picker the share dialog and Settings → General share: a pill per preset, a custom number of hours or
 * days, the moment the link would stop working, and S3's 7-day limit said under it. Rendered in a form of its
 * own, with the value it holds printed beside it.
 */

interface HarnessProps {
  /** What the field opens on, in hours. */
  hours: number | null;
  limits: ExpiryLimits;
}

/**
 * The field in a one-field form, and the hours it holds, so a story can read what a choice comes to.
 *
 * @param props - The starting hours and the limits.
 * @returns The form.
 */
function Harness({ hours, limits }: HarnessProps) {
  const defaultValues: { expiresInHours: number | null } = { expiresInHours: hours };
  const form = useAppForm({ defaultValues });
  return (
    <div className="grid max-w-lg gap-4 p-4">
      <LinkExpiryField
        form={form}
        name="expiresInHours"
        label="Expires after"
        limits={limits}
        validators={{ onChange: ({ value }) => expiryError(value, limits) }}
      />
      <form.Subscribe selector={(state) => state.values.expiresInHours}>
        {(value) => <output aria-label="Hours held">{value === null ? 'none' : String(value)}</output>}
      </form.Subscribe>
    </div>
  );
}

const meta = {
  title: 'Domain/LinkExpiryField',
  component: Harness,
  args: { hours: 24, limits: LIMITS },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The group the pills are in, named by the field's title. */
function pillsOf(canvas: ReturnType<typeof within>) {
  return within(canvas.getByRole('group', { name: 'Expires after' }));
}

/** It opens on the preset it was given, says when that ends, and says the 7-day limit. */
export const Presets: Story = {
  play: async ({ canvas }) => {
    const pills = pillsOf(canvas);
    await expect(pills.getAllByRole('button').map((pill) => pill.textContent)).toEqual([
      '1 hour',
      '1 day',
      '3 days',
      '7 days',
      'Custom',
    ]);
    await expect(pills.getByRole('button', { name: '1 day' })).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.getByText(/Stops working .* \(1 day from now\)/)).toBeInTheDocument();
    await expect(canvas.getByText(/7 days is the most S3 allows/)).toBeInTheDocument();

    await userEvent.click(pills.getByRole('button', { name: '3 days' }));
    await expect(canvas.getByRole('status', { name: 'Hours held' })).toHaveTextContent('72');
    await expect(canvas.getByText(/\(3 days from now\)/)).toBeInTheDocument();
  },
};

/**
 * Picks the custom amount's unit, and waits for its list to close: while it is open the rest of the page is hidden
 * from assistive technology, and so from queries by role.
 */
async function chooseUnit(canvasElement: HTMLElement, unit: string) {
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(page.getByRole('combobox', { name: 'Custom expiry unit' }));
  await userEvent.click(await page.findByRole('option', { name: unit }));
  await waitFor(() => expect(page.queryAllByRole('option')).toHaveLength(0));
}

/** Custom: it opens on the duration already chosen, then takes a number and a unit, in whole hours. */
export const Custom: Story = {
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(pillsOf(canvas).getByRole('button', { name: 'Custom' }));
    const amount = canvas.getByRole('spinbutton', { name: 'Custom expiry' });
    await expect(amount).toHaveValue(1);
    await expect(canvas.getByRole('combobox', { name: 'Custom expiry unit' })).toHaveTextContent('Days');
    await expect(canvas.getByRole('status', { name: 'Hours held' })).toHaveTextContent('24');

    await chooseUnit(canvasElement, 'Hours');
    await userEvent.clear(amount);
    await userEvent.type(amount, '36');
    await expect(canvas.getByRole('status', { name: 'Hours held' })).toHaveTextContent('36');
    await expect(canvas.getByText(/\(36 hours from now\)/)).toBeInTheDocument();

    await chooseUnit(canvasElement, 'Days');
    await userEvent.clear(amount);
    await userEvent.type(amount, '5');
    await waitFor(() => expect(canvas.getByRole('status', { name: 'Hours held' })).toHaveTextContent('120'));
    await expect(canvas.getByText(/\(5 days from now\)/)).toBeInTheDocument();
  },
};

/** Past seven days, or not a whole number, is refused under the field, and no end moment is promised. */
export const OutOfRange: Story = {
  play: async ({ canvas }) => {
    await userEvent.click(pillsOf(canvas).getByRole('button', { name: 'Custom' }));
    const amount = canvas.getByRole('spinbutton', { name: 'Custom expiry' });
    await userEvent.clear(amount);
    await userEvent.type(amount, '200');
    await expect(await canvas.findByText('Choose from 1 hour to 7 days')).toBeInTheDocument();
    await expect(canvas.queryByText(/Stops working/)).not.toBeInTheDocument();

    await userEvent.clear(amount);
    await expect(
      await canvas.findByText('Enter a whole number of hours or days, from 1 hour to 7 days'),
    ).toBeInTheDocument();
    await expect(canvas.getByRole('status', { name: 'Hours held' })).toHaveTextContent('none');
  },
};

/** A value that is no preset opens on Custom, in days when it is whole days. */
export const OpensOnCustom: Story = {
  args: { hours: 48 },
  play: async ({ canvas }) => {
    await expect(pillsOf(canvas).getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.getByRole('spinbutton', { name: 'Custom expiry' })).toHaveValue(2);
    await expect(canvas.getByRole('combobox', { name: 'Custom expiry unit' })).toHaveTextContent('Days');
  },
};

/** Narrower limits from the server: only the presets inside them are offered, and the note follows. */
export const NarrowerLimits: Story = {
  args: { hours: 1, limits: { ...LIMITS, maxLinkExpiryHours: 24 } },
  play: async ({ canvas }) => {
    await expect(pillsOf(canvas).queryByRole('button', { name: '7 days' })).not.toBeInTheDocument();
    await expect(canvas.getByText(/1 day is the most S3 allows/)).toBeInTheDocument();
  },
};

/** Phone width: the pills wrap rather than push the page sideways. */
export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(pillsOf(canvas).getByRole('button', { name: 'Custom' }));
    await expect(canvas.getByRole('spinbutton', { name: 'Custom expiry' })).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
