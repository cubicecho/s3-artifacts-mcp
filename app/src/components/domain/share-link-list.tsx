import { Link } from 'react-router';
import { graphql } from '@/__generated__';
import type { ShareLinkRowFragment, ShareLinkState } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { Ban, Link2 } from '@/components/domain/app-icons';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { ArrowRight, CircleCheck, Clock, X } from '@/components/ui/icons';
import { formatDateTime, joinStats } from '@/lib/format';
import { documentPath } from '@/lib/routes';
import { CREATOR_LABELS, PERMISSION_LABELS, STATE_LABELS } from '@/lib/share-links';

/** What a row shows of a link. `id` is selected for `url` and `state`, which the server reads from it. */
export const ShareLinkRow = graphql(`
  fragment ShareLinkRow on ShareLink {
    id
    label
    permission
    expiresAt
    createdBy
    createdAt
    url
    state
    document {
      id
      title
    }
  }
`);

/** Removes a link from the list. Its URL keeps working: the bucket checks the signature, not the list. */
export const DeleteShareLink = graphql(`
  mutation DeleteShareLink($id: UUID!) {
    deleteShareLink(id: $id)
  }
`);

/** The glyph each state is drawn with beside its word, so the state is never told by colour alone. */
const STATE_ICONS = {
  active: <CircleCheck aria-hidden className="text-positive" />,
  expired: <Clock aria-hidden className="text-foreground/60" />,
  revoked: <Ban aria-hidden className="text-negative" />,
} satisfies Record<ShareLinkState, unknown>;

/**
 * A link's state as a word and an icon.
 *
 * @param props - The state.
 * @returns The badge.
 */
export function ShareLinkStateBadge({ state }: { state: ShareLinkState }) {
  return (
    <Badge variant="outline">
      {STATE_ICONS[state]}
      {STATE_LABELS[state]}
    </Badge>
  );
}

/**
 * When a link stops working, or stopped.
 *
 * @param link - The link.
 * @returns "Expires …", "Expired …", or for a revoked one, that it no longer opens.
 */
function expiryText(link: ShareLinkRowFragment): string {
  const at = formatDateTime(link.expiresAt);
  const words = { active: `Expires ${at}`, expired: `Expired ${at}`, revoked: 'No longer opens' } as const;
  return words[link.state];
}

interface ShareLinkListProps {
  links: readonly ShareLinkRowFragment[];
  /** Removes a link from the list. Its URL keeps working until it expires. */
  onRemove: (id: string) => void;
  /** Names each link's document with a link to it, for a list of every document's links. */
  showDocument?: boolean | undefined;
  /** Told when the clipboard refused a URL, as it does where the app is not served over HTTPS. */
  onCopyError?: ((error: unknown) => void) | undefined;
}

/**
 * Share links as rows: the label, what it lets its holder do, its state as a word and an icon, when it
 * expires and who made it, with Copy while it still opens and Remove from list.
 *
 * @param props - The links, and what Remove and a refused copy do.
 * @returns The list.
 */
export function ShareLinkList({ links, onRemove, showDocument = false, onCopyError }: ShareLinkListProps) {
  return (
    <List
      label="Share links"
      contentSlot={links.map((link) => {
        const name = link.label ?? `${PERMISSION_LABELS[link.permission]} link`;
        const isActive = link.state === 'active';
        return (
          <ListItem
            key={link.id}
            leadingSlot={<Link2 aria-hidden className="size-4 text-foreground/60" />}
            title={name}
            description={joinStats(
              showDocument && link.document.title,
              PERMISSION_LABELS[link.permission],
              expiryText(link),
              CREATOR_LABELS[link.createdBy],
            )}
            meta={<ShareLinkStateBadge state={link.state} />}
            actionSlot={
              <>
                {link.url && isActive && <CopyButton value={link.url} label={`Copy ${name}`} onError={onCopyError} />}
                {showDocument && (
                  <Button
                    aria-label={`Open ${link.document.title}`}
                    variant="outline"
                    size="icon-sm"
                    iconSlot={<ArrowRight />}
                    linkSlot={<Link to={documentPath(link.document.id)} />}
                  />
                )}
                <ConfirmButton
                  size="icon-sm"
                  aria-label={`Remove ${name} from the list`}
                  hint="Remove from list"
                  iconSlot={<X />}
                  title={`Remove “${name}” from the list?`}
                  description={
                    isActive
                      ? 'The link keeps working until it expires: the bucket checks its signature, not this list. To stop it now, revoke all of the document’s links instead.'
                      : 'Only the row goes. The link already no longer opens.'
                  }
                  confirmLabel="Remove from list"
                  onConfirm={() => onRemove(link.id)}
                />
              </>
            }
          />
        );
      })}
    />
  );
}
