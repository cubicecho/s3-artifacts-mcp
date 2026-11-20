import { describe, expect, it } from 'vitest';
import { createSecretBox, SecretPurpose, SecretUnreadableError, SignaturePurpose } from '../../core/secrets.ts';
import { TEST_SECRET } from '../helpers.ts';

const ROTATED_SECRET = 'another-secret-0123456789abcdef0123456789';

describe('secrets', () => {
  const box = createSecretBox(TEST_SECRET);

  it('opens what it sealed, and never stores the plaintext', () => {
    const sealed = box.seal('s3am-dev-secret', SecretPurpose.BucketSecret);
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain('s3am-dev-secret');
    expect(box.open(sealed, SecretPurpose.BucketSecret)).toBe('s3am-dev-secret');
  });

  it('seals the same value differently each time', () => {
    expect(box.seal('same', SecretPurpose.BucketSecret)).not.toBe(box.seal('same', SecretPurpose.BucketSecret));
  });

  it('opens with a box built from the same secret, as after a restart', () => {
    const sealed = box.seal('kept', SecretPurpose.BucketSecret);
    expect(createSecretBox(TEST_SECRET).open(sealed, SecretPurpose.BucketSecret)).toBe('kept');
  });

  it('cannot open what was sealed before BETTER_AUTH_SECRET changed, and says so rather than crashing', () => {
    const sealed = box.seal('lost', SecretPurpose.BucketSecret);
    const rotated = createSecretBox(ROTATED_SECRET);
    expect(() => rotated.open(sealed, SecretPurpose.BucketSecret)).toThrow(SecretUnreadableError);
    expect(rotated.canOpen(sealed, SecretPurpose.BucketSecret)).toBe(false);
    expect(box.canOpen(sealed, SecretPurpose.BucketSecret)).toBe(true);
  });

  it('refuses a damaged or unknown envelope as unreadable', () => {
    const [version, iv, ciphertext, tag] = box.seal('value', SecretPurpose.BucketSecret).split('.');
    // The first character: the last one of an unpadded base64url string may carry only padding bits.
    const flipped = `${ciphertext.startsWith('A') ? 'B' : 'A'}${ciphertext.slice(1)}`;
    expect(box.canOpen([version, iv, flipped, tag].join('.'), SecretPurpose.BucketSecret)).toBe(false);
    expect(box.canOpen(['v9', iv, ciphertext, tag].join('.'), SecretPurpose.BucketSecret)).toBe(false);
    expect(box.canOpen('plaintext', SecretPurpose.BucketSecret)).toBe(false);
  });

  it('verifies its own signature, and nothing else', () => {
    const signature = box.sign('doc\nkey', SignaturePurpose.ContentUrl);
    expect(box.verify('doc\nkey', signature, SignaturePurpose.ContentUrl)).toBe(true);
    expect(box.verify('doc\nother-key', signature, SignaturePurpose.ContentUrl)).toBe(false);
    expect(box.verify('doc\nkey', `${signature}A`, SignaturePurpose.ContentUrl)).toBe(false);
    expect(box.verify('doc\nkey', '', SignaturePurpose.ContentUrl)).toBe(false);
  });

  it('signs with a key of its own, which a rotated secret does not share', () => {
    const signature = box.sign('message', SignaturePurpose.ContentUrl);
    expect(createSecretBox(ROTATED_SECRET).verify('message', signature, SignaturePurpose.ContentUrl)).toBe(false);
  });
});
