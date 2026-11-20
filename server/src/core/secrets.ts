import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

// Credentials the server has to read back (a bucket's secret key, later a share link's URL) are
// sealed with AES-256-GCM before they reach the database. The key is derived from
// `BETTER_AUTH_SECRET` by HKDF, so there is no second secret to keep, and rotating that one makes
// everything sealed with it unreadable: `open` then throws `SecretUnreadableError`, which the
// caller turns into "enter the secret again" rather than a crash.
//
// The same secret also derives a second, separate key for signing short-lived tokens the server
// hands out and later checks (a document's content URL). Rotating the secret invalidates them too.

/** What a sealed value is for. It is bound into the ciphertext, so one cannot be opened as another. */
export const SecretPurpose = {
  BucketSecret: 'bucket-secret',
} as const;
/** One of the purposes in `SecretPurpose`. */
export type SecretPurpose = (typeof SecretPurpose)[keyof typeof SecretPurpose];

/** What a signature is for. It is signed along with the message, so one cannot pass as another. */
export const SignaturePurpose = {
  /** `GET /api/documents/:id/content?t=…`, for elements that cannot send a session. */
  ContentUrl: 'content-url',
} as const;
/** One of the purposes in `SignaturePurpose`. */
export type SignaturePurpose = (typeof SignaturePurpose)[keyof typeof SignaturePurpose];

/** The envelope's format version, its first segment. A new format adds a version and keeps opening this one. */
const ENVELOPE_VERSION = 'v1';
/** Separates the envelope's segments. Not in base64url's alphabet. */
const SEPARATOR = '.';
/** The envelope's segments: version, IV, ciphertext and tag. */
const ENVELOPE_SEGMENTS = 4;
const CIPHER = 'aes-256-gcm';
/** AES-256's key length, in bytes. */
const KEY_BYTES = 32;
/** GCM's recommended IV length, in bytes. */
const IV_BYTES = 12;
/** GCM's full tag length, in bytes. */
const TAG_BYTES = 16;
const HKDF_DIGEST = 'sha256';
/** HKDF's salt. Fixed: the input is already a random secret, and the key must be the same on every boot. */
const HKDF_SALT = 's3-artifacts-mcp';
/** HKDF's info, which keeps this key apart from anything else derived from the same secret. */
const HKDF_INFO = 'secrets v1';
/** HKDF's info for the signing key, so it is never the encryption key. */
const HKDF_SIGNING_INFO = 'signatures v1';
const HMAC_DIGEST = 'sha256';
/** HMAC-SHA256's key length, in bytes: its block size would do no better. */
const SIGNING_KEY_BYTES = 32;
/** Separates a signature's purpose from its message. Never in a purpose. */
const PURPOSE_SEPARATOR = '\n';
const ENCODING = 'base64url';

/** A sealed value could not be opened: the key it was sealed with is gone, or the envelope is damaged. */
export class SecretUnreadableError extends Error {
  /**
   * @param message - Why it could not be opened.
   */
  constructor(message: string) {
    super(message);
    this.name = 'SecretUnreadableError';
  }
}

/** Seals and opens credentials, and signs and checks tokens, with keys derived from one secret. */
export interface SecretBox {
  /**
   * Encrypts a value for the database.
   *
   * @param plaintext - The credential.
   * @param purpose - What it is, which only the same purpose opens.
   * @returns The envelope: `v1.<iv>.<ciphertext>.<tag>`, base64url.
   */
  seal(plaintext: string, purpose: SecretPurpose): string;
  /**
   * Decrypts an envelope made by `seal`.
   *
   * @param envelope - What `seal` returned.
   * @param purpose - What it was sealed as.
   * @returns The credential.
   * @throws SecretUnreadableError when the key changed, the purpose differs or the envelope is damaged.
   */
  open(envelope: string, purpose: SecretPurpose): string;
  /**
   * Whether an envelope still opens.
   *
   * @param envelope - What `seal` returned.
   * @param purpose - What it was sealed as.
   * @returns False where `open` would throw.
   */
  canOpen(envelope: string, purpose: SecretPurpose): boolean;
  /**
   * Signs a message with HMAC-SHA256.
   *
   * @param message - What the signature vouches for.
   * @param purpose - What it is for, which only the same purpose verifies.
   * @returns The signature, base64url.
   */
  sign(message: string, purpose: SignaturePurpose): string;
  /**
   * Checks a signature made by `sign`, in constant time.
   *
   * @param message - What the signature should vouch for.
   * @param signature - What the caller presented.
   * @param purpose - What it was signed for.
   * @returns Whether it is that message's signature, for that purpose, under the current secret.
   */
  verify(message: string, signature: string, purpose: SignaturePurpose): boolean;
}

/**
 * Builds the box that seals credentials with a key derived from the instance's secret.
 *
 * @param masterSecret - `BETTER_AUTH_SECRET` (`authSecret()`), or a test's own.
 * @returns The box. The key is derived once, here.
 */
export function createSecretBox(masterSecret: string): SecretBox {
  const key = Buffer.from(hkdfSync(HKDF_DIGEST, masterSecret, HKDF_SALT, HKDF_INFO, KEY_BYTES));
  const signingKey = Buffer.from(hkdfSync(HKDF_DIGEST, masterSecret, HKDF_SALT, HKDF_SIGNING_INFO, SIGNING_KEY_BYTES));

  const mac = (message: string, purpose: SignaturePurpose): Buffer =>
    createHmac(HMAC_DIGEST, signingKey).update(`${purpose}${PURPOSE_SEPARATOR}${message}`).digest();

  const open = (envelope: string, purpose: SecretPurpose): string => {
    const segments = envelope.split(SEPARATOR);
    const [version, iv, ciphertext, tag] = segments;
    const isUnknownFormat = segments.length !== ENVELOPE_SEGMENTS || version !== ENVELOPE_VERSION;
    if (isUnknownFormat) {
      throw new SecretUnreadableError('The stored secret is not in a format this version can read.');
    }
    try {
      const decipher = createDecipheriv(CIPHER, key, Buffer.from(iv, ENCODING), { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(purpose));
      decipher.setAuthTag(Buffer.from(tag, ENCODING));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, ENCODING)), decipher.final()]).toString('utf8');
    } catch {
      // GCM says only "unable to authenticate", whichever of the key, the purpose or the bytes is wrong.
      throw new SecretUnreadableError(
        'The stored secret cannot be decrypted. BETTER_AUTH_SECRET may have changed since it was saved.',
      );
    }
  };

  return {
    seal(plaintext, purpose) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(purpose));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return [ENVELOPE_VERSION, iv, ciphertext, cipher.getAuthTag()]
        .map((part) => (typeof part === 'string' ? part : part.toString(ENCODING)))
        .join(SEPARATOR);
    },
    open,
    canOpen(envelope, purpose) {
      try {
        open(envelope, purpose);
        return true;
      } catch (error) {
        if (error instanceof SecretUnreadableError) {
          return false;
        }
        throw error;
      }
    },
    sign(message, purpose) {
      return mac(message, purpose).toString(ENCODING);
    },
    verify(message, signature, purpose) {
      const expected = mac(message, purpose);
      const presented = Buffer.from(signature, ENCODING);
      // timingSafeEqual throws on a length mismatch, and the length is no secret.
      const isSameLength = presented.length === expected.length;
      return isSameLength && timingSafeEqual(presented, expected);
    },
  };
}
