import { Combobox } from '@/components/combobox';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { SegmentedButton, SegmentedGroup } from '@/components/ui/segmented';
import { type DocumentFilters, TagMatch } from '@/lib/document-filters';
import { type TagChipData, tagOptions } from '@/lib/tags';

/** The filter's "every bucket" and "every type" choice. Neither a slug nor a content type looks like it. */
export const ALL = '*';

/** A type the list can be filtered to: the bare content type, and what the table calls it. */
export interface TypeChoice {
  value: string;
  label: string;
}

interface DocumentFilterBarProps {
  /** The filters as the URL has them. */
  filters: DocumentFilters;
  /** The buckets, sorted, by slug. */
  buckets: readonly { slug: string; name: string }[];
  /** Every tag of the owner's. */
  tags: readonly TagChipData[];
  /** The types of the documents there are. */
  types: readonly TypeChoice[];
  /** Handed the filters to change. */
  onChange: (change: Partial<DocumentFilters>) => void;
  /** Puts every filter back at "everything". Shown only while one is set. */
  onClear: () => void;
}

/**
 * The documents list's filters, in one wrapping row: the title text, the bucket, the type, and the tags with
 * whether a document needs any of them or all of them. It holds nothing: the page keeps the filters in the URL.
 *
 * @param props - The filters, the choices, and what changes them.
 * @returns The filter bar.
 */
export function DocumentFilterBar({ filters, buckets, tags, types, onChange, onClear }: DocumentFilterBarProps) {
  const known = new Set(tags.map((tag) => tag.id));
  const tagIds = filters.tagIds.filter((id) => known.has(id));
  const isFiltered = filters.bucket !== null || tagIds.length > 0 || filters.title !== '' || filters.type !== null;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <FormField
        className="w-full sm:w-56"
        label="Title"
        controlSlot={(props) => (
          <SearchInput
            {...props}
            placeholder="Find by title"
            value={filters.title}
            onChangeText={(title) => onChange({ title })}
          />
        )}
      />
      <FormField
        className="w-full sm:w-44"
        label="Bucket"
        controlSlot={(props) => (
          <Combobox
            {...props}
            options={[
              { value: ALL, label: 'All buckets' },
              ...buckets.map((bucket) => ({ value: bucket.slug, label: bucket.name })),
            ]}
            value={buckets.some((bucket) => bucket.slug === filters.bucket) ? (filters.bucket ?? ALL) : ALL}
            onValueChange={(bucket) => onChange({ bucket: bucket === ALL ? null : bucket })}
          />
        )}
      />
      <FormField
        className="w-full sm:w-44"
        label="Type"
        controlSlot={(props) => (
          <Combobox
            {...props}
            options={[{ value: ALL, label: 'All types' }, ...types]}
            value={types.some((type) => type.value === filters.type) ? (filters.type ?? ALL) : ALL}
            onValueChange={(type) => onChange({ type: type === ALL ? null : type })}
          />
        )}
      />
      <FormField
        className="w-full sm:w-64"
        label="Tags"
        controlSlot={(props) => (
          <Combobox
            {...props}
            multiple
            popoverLabel="Filter by tags"
            searchLabel="Find a tag"
            emptyMessage="No tag has that name."
            options={tagOptions(tags)}
            value={tagIds}
            onValueChange={(next) => onChange({ tagIds: next })}
            placeholder="Any tags"
          />
        )}
      />
      {tagIds.length > 1 && (
        <SegmentedGroup
          aria-label="Documents with"
          value={filters.match}
          onValueChange={(match) => onChange({ match })}
        >
          <SegmentedButton value={TagMatch.Any}>Any of them</SegmentedButton>
          <SegmentedButton value={TagMatch.All}>All of them</SegmentedButton>
        </SegmentedGroup>
      )}
      {isFiltered && <Button variant="outline" content="Clear filters" onClick={onClear} />}
    </div>
  );
}
