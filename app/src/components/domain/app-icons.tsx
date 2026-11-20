import {
  Ban as BanSource,
  Database as DatabaseSource,
  Link2 as Link2Source,
  LogOut as LogOutSource,
} from 'lucide-react';
import { icon } from '@/components/ui/icons';

// Glyphs this app needs that `@cubeui/icons` does not carry, wrapped the way it
// says to add one, so they size and colour like the rest.

/** Sign out. */
export const LogOut = icon(LogOutSource);
/** A bucket: where documents are stored. */
export const Database = icon(DatabaseSource);
/** A share link. */
export const Link2 = icon(Link2Source);
/** A share link that was revoked. */
export const Ban = icon(BanSource);
