import { Combobox } from '@/components/combobox';
import { type TagChipData, tagOptions } from '@/lib/tags';

interface TagPickerProps {
  /** Every tag that may be chosen. A chosen tag missing from it is still drawn, from `chosen`. */
  tags: readonly TagChipData[];
  /** The tags chosen now. */
  chosen: readonly TagChipData[];
  /** Handed the ids of every tag chosen after a pick or a removal. */
  onValueChange: (tagIds: string[]) => void;
  /** Makes a tag of a name that matches none, and chooses it. Left out, a search that matches nothing says so. */
  onCreateTag?: (name: string) => void;
  /** The picker's accessible name: "Tags of Quarterly report". */
  label: string;
  /** While a save is on its way, or the tags are still loading. */
  disabled?: boolean;
  /** What the trigger says with no tag chosen. */
  placeholder?: string;
}

/**
 * Choosing a document's tags: the chosen ones as chips on a button that opens a search over every tag, which can
 * make one by the name typed when none matches. It holds nothing itself: the caller saves each change.
 *
 * @param props - The tags, the chosen ones, and what saves and creates.
 * @returns The picker.
 */
export function TagPicker({
  tags,
  chosen,
  onValueChange,
  onCreateTag,
  label,
  disabled = false,
  placeholder = 'No tags',
}: TagPickerProps) {
  const known = new Set(tags.map((tag) => tag.id));
  const options = tagOptions([...tags, ...chosen.filter((tag) => known.has(tag.id) === false)]);
  return (
    <Combobox
      multiple
      aria-label={label}
      popoverLabel="Choose tags"
      searchLabel="Find a tag"
      searchPlaceholder="Find or make a tag…"
      emptyMessage="No tag has that name."
      createLabel="Make the tag"
      options={options}
      value={chosen.map((tag) => tag.id)}
      onValueChange={onValueChange}
      onCreateOption={onCreateTag}
      maxDisplay={chosen.length}
      placeholder={placeholder}
      disabled={disabled}
    />
  );
}
