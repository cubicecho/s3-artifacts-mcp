import { Link } from 'react-router';
import { TagChips } from '@/components/domain/tag-chip';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { typeLabel } from '@/lib/document-type';
import { formatBytes, formatDate } from '@/lib/format';
import { documentPath } from '@/lib/routes';
import type { TagChipData } from '@/lib/tags';

/** One row of the table: a document, with its tags, and the bucket it is in. */
export interface DocumentRow {
  document: {
    id: string;
    title: string;
    contentType: string;
    size: number;
    createdAt: string;
    tags: readonly TagChipData[];
  };
  bucket: { name: string };
}

interface DocumentTableProps {
  /** The rows, already filtered and sorted. */
  rows: readonly DocumentRow[];
  /** The ids of the documents chosen for a bulk change. */
  selected: ReadonlySet<string>;
  /** Handed the chosen ids after a box is ticked or cleared. */
  onSelectedChange: (selected: Set<string>) => void;
}

/**
 * The documents as a table, one link per row, each with a box that chooses it for a bulk change and its tags as
 * chips. The box in the header chooses every row shown, or none. Below `sm` the tags are left out, and below `md`
 * the type and the date, so the title, the bucket and the size fit a phone without the page scrolling sideways.
 *
 * @param props - The rows, and which are chosen.
 * @returns The table.
 */
export function DocumentTable({ rows, selected, onSelectedChange }: DocumentTableProps) {
  const chosenHere = rows.filter((row) => selected.has(row.document.id)).length;
  const isAllChosen = rows.length > 0 && chosenHere === rows.length;
  const isSomeChosen = chosenHere > 0 && isAllChosen === false;

  const toggle = (id: string, isChosen: boolean) => {
    const next = new Set(selected);
    if (isChosen) {
      next.add(id);
    } else {
      next.delete(id);
    }
    onSelectedChange(next);
  };
  const toggleAll = (isChosen: boolean) => {
    const next = new Set(selected);
    for (const { document } of rows) {
      if (isChosen) {
        next.add(document.id);
      } else {
        next.delete(document.id);
      }
    }
    onSelectedChange(next);
  };

  return (
    <Table>
      <TableCaption className="sr-only">Documents</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8">
            <Checkbox
              aria-label="Choose every document shown"
              checked={isSomeChosen ? 'indeterminate' : isAllChosen}
              onCheckedChange={(checked) => toggleAll(checked === true)}
            />
          </TableHead>
          <TableHead>Title</TableHead>
          <TableHead className="hidden sm:table-cell">Tags</TableHead>
          <TableHead>Bucket</TableHead>
          <TableHead className="hidden md:table-cell">Type</TableHead>
          <TableHead className="text-right">Size</TableHead>
          <TableHead className="hidden md:table-cell">Uploaded</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ document, bucket }) => (
          <TableRow key={document.id} data-state={selected.has(document.id) ? 'selected' : undefined}>
            <TableCell>
              <Checkbox
                aria-label={`Choose ${document.title}`}
                checked={selected.has(document.id)}
                onCheckedChange={(checked) => toggle(document.id, checked === true)}
              />
            </TableCell>
            <TableHead className="max-w-[16rem] font-normal">
              <Link
                className="block truncate font-medium text-foreground underline-offset-2 hover:underline"
                to={documentPath(document.id)}
              >
                {document.title}
              </Link>
            </TableHead>
            <TableCell className="hidden max-w-[16rem] sm:table-cell">
              <TagChips tags={document.tags} label={`Tags of ${document.title}`} />
            </TableCell>
            <TableCell className="max-w-[10rem] truncate">{bucket.name}</TableCell>
            <TableCell className="hidden md:table-cell">{typeLabel(document.contentType)}</TableCell>
            <TableCell className="whitespace-nowrap text-right">{formatBytes(document.size)}</TableCell>
            <TableCell className="hidden whitespace-nowrap md:table-cell">{formatDate(document.createdAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
