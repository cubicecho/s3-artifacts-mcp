import { Badge } from '@/components/ui/badge';
import { readableTextColor } from '@/lib/readable-text-color';
import type { TagChipData } from '@/lib/tags';

interface TagChipProps {
  /** The tag. Its colour fills the chip, and the ink is picked for contrast against it. */
  tag: TagChipData;
  /** Draws a ✕ that takes the tag off, named "Remove <name>". */
  onRemove?: () => void;
}

/**
 * One tag, as a pill in its own colour. The name is always on it, so the colour is never the only
 * thing that says which tag it is.
 *
 * @param props - The tag, and what takes it off.
 * @returns The chip.
 */
export function TagChip({ tag, onRemove }: TagChipProps) {
  return (
    <Badge backgroundColor={tag.color} textColor={readableTextColor(tag.color)} onRemove={onRemove}>
      {tag.name}
    </Badge>
  );
}

interface TagChipsProps {
  /** The tags, in the order to draw them. */
  tags: readonly TagChipData[];
  /** What the row of chips is, for a screen reader: "Tags of Quarterly report". */
  label: string;
}

/**
 * A wrapping row of tags, for a table cell or a card. Draws nothing for none.
 *
 * @param props - The tags and what they are.
 * @returns The chips, or null.
 */
export function TagChips({ tags, label }: TagChipsProps) {
  if (tags.length === 0) {
    return null;
  }
  return (
    <ul aria-label={label} className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <li key={tag.id}>
          <TagChip tag={tag} />
        </li>
      ))}
    </ul>
  );
}
