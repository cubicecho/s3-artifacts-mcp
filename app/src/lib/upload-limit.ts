import { graphql } from '@/__generated__';

/** Bytes in one mebibyte, the unit the upload limit is set in. */
export const BYTES_PER_MEBIBYTE = 1_048_576;
/** Bytes in one gibibyte, the unit a whole number of them is shown in. */
const BYTES_PER_GIBIBYTE = 1_073_741_824;

/**
 * The owner's upload limit, which the upload panel shows and checks a file against before asking the server,
 * which checks it again. `userId` is what the cache keys the settings row by.
 */
export const UploadLimit = graphql(`
  query UploadLimit {
    appSettings {
      userId
      maxUploadBytes
    }
  }
`);

/**
 * An upload limit as the server writes it: whole gibibytes as GiB, anything else in MiB.
 *
 * @param bytes - The limit.
 * @returns For example "100 MiB" or "50 GiB".
 */
export function describeUploadLimit(bytes: number): string {
  const isWholeGibibytes = bytes >= BYTES_PER_GIBIBYTE && bytes % BYTES_PER_GIBIBYTE === 0;
  return isWholeGibibytes ? `${bytes / BYTES_PER_GIBIBYTE} GiB` : `${Math.floor(bytes / BYTES_PER_MEBIBYTE)} MiB`;
}
