import { APP_SETTINGS_DEFAULTS } from '@cubicecho/s3-artifacts-mcp-db/defaults';
import { appSettings, users } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { describeBytes } from '../../app-settings/app-settings.ts';
import { SHARE_LINK_DEFAULTS, UPLOAD_DEFAULTS } from '../../core/defaults.ts';
import { ErrorCode } from '../../core/errors.ts';
import {
  closeTestDb,
  createClient,
  createTestAuth,
  createTestDb,
  createUser,
  resetTestDb,
  type TestDb,
} from '../helpers.ts';

// Settings → General: the row every account has, what may be saved in it, and the bounds the app is told.

const FIELDS = 'userId maxUploadBytes defaultLinkExpiryHours defaultLinkPermission';
const READ = `{ appSettings { ${FIELDS} } }`;
const UPDATE = `mutation ($input: AppSettingsInput!) { updateAppSettings(input: $input) { ${FIELDS} } }`;
const LIMITS = '{ appSettingsLimits { minUploadBytes maxUploadBytes minLinkExpiryHours maxLinkExpiryHours } }';

describe('app settings', () => {
  let db: TestDb;
  let owner: string;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(() => closeTestDb(db));

  beforeEach(async () => {
    await resetTestDb(db);
    owner = await createUser(db, 'owner@example.com');
  });

  const client = () => createClient(db, owner);

  it('starts every account on the shipped defaults', async () => {
    expect((await client().expectOk(READ)).appSettings).toEqual({ userId: owner, ...APP_SETTINGS_DEFAULTS });
  });

  it('gives an account made by better-auth its row', async () => {
    await resetTestDb(db);
    const { auth } = createTestAuth(db);
    const made = await (await auth.$context).internalAdapter.createUser(
      { email: 'first@example.com', name: '' },
      { method: 'magic-link' },
    );
    const [row] = await db.select().from(appSettings).where(eq(appSettings.userId, made.id));
    expect(row).toMatchObject({ userId: made.id, ...APP_SETTINGS_DEFAULTS });
  });

  it('saves what is sent and keeps what is not', async () => {
    const { updateAppSettings } = await client().expectOk(UPDATE, {
      input: { maxUploadBytes: 2 * UPLOAD_DEFAULTS.minUploadBytes, defaultLinkPermission: 'view' },
    });
    expect(updateAppSettings).toEqual({
      userId: owner,
      maxUploadBytes: 2 * UPLOAD_DEFAULTS.minUploadBytes,
      defaultLinkExpiryHours: APP_SETTINGS_DEFAULTS.defaultLinkExpiryHours,
      defaultLinkPermission: 'view',
    });
    const { updateAppSettings: again } = await client().expectOk(UPDATE, {
      input: { defaultLinkExpiryHours: SHARE_LINK_DEFAULTS.maxExpiryHours, maxUploadBytes: null },
    });
    expect(again).toMatchObject({
      maxUploadBytes: 2 * UPLOAD_DEFAULTS.minUploadBytes,
      defaultLinkExpiryHours: SHARE_LINK_DEFAULTS.maxExpiryHours,
    });
  });

  it('takes the bounds themselves', async () => {
    const input = {
      maxUploadBytes: UPLOAD_DEFAULTS.maxUploadBytes,
      defaultLinkExpiryHours: SHARE_LINK_DEFAULTS.minExpiryHours,
    };
    expect((await client().expectOk(UPDATE, { input })).updateAppSettings).toMatchObject(input);
  });

  it('makes the row when an account has none', async () => {
    await db.delete(appSettings).where(eq(appSettings.userId, owner));
    const { updateAppSettings } = await client().expectOk(UPDATE, { input: {} });
    expect(updateAppSettings).toEqual({ userId: owner, ...APP_SETTINGS_DEFAULTS });
  });

  it.each([
    ['an upload limit under 1 MiB', { maxUploadBytes: UPLOAD_DEFAULTS.minUploadBytes - 1 }, /at least 1 MiB/],
    ['an upload limit over 50 GiB', { maxUploadBytes: UPLOAD_DEFAULTS.maxUploadBytes + 1 }, /at most 50 GiB/],
    ['a fractional upload limit', { maxUploadBytes: 1_500_000.5 }, /whole number of bytes/],
    ['a default expiry of no time', { defaultLinkExpiryHours: 0 }, /at least 1 hour/],
    ['a default expiry over 7 days', { defaultLinkExpiryHours: SHARE_LINK_DEFAULTS.maxExpiryHours + 1 }, /7 days/],
  ])('refuses %s, and saves nothing', async (_case, input, message) => {
    const error = await client().expectError(UPDATE, { input: { defaultLinkPermission: 'view', ...input } });
    expect(error.code).toBe(ErrorCode.BadUserInput);
    expect(error.message).toMatch(message);
    expect((await client().expectOk(READ)).appSettings).toEqual({ userId: owner, ...APP_SETTINGS_DEFAULTS });
  });

  it('tells the app the bounds', async () => {
    expect((await client().expectOk(LIMITS)).appSettingsLimits).toEqual({
      minUploadBytes: UPLOAD_DEFAULTS.minUploadBytes,
      maxUploadBytes: UPLOAD_DEFAULTS.maxUploadBytes,
      minLinkExpiryHours: SHARE_LINK_DEFAULTS.minExpiryHours,
      maxLinkExpiryHours: SHARE_LINK_DEFAULTS.maxExpiryHours,
    });
  });

  it('changes only the caller’s own row', async () => {
    const other = await createUser(db, 'other@example.com');
    await createClient(db, other).expectOk(UPDATE, { input: { defaultLinkPermission: 'view' } });
    expect((await client().expectOk(READ)).appSettings.defaultLinkPermission).toBe('download');
  });

  it('refuses the unauthenticated', async () => {
    for (const operation of [READ, LIMITS]) {
      expect((await createClient(db, null).expectError(operation)).code).toBe(ErrorCode.Unauthenticated);
    }
    const { code } = await createClient(db, null).expectError(UPDATE, { input: {} });
    expect(code).toBe(ErrorCode.Unauthenticated);
  });

  it('goes with its account', async () => {
    await db.delete(users).where(eq(users.id, owner));
    expect(await db.select().from(appSettings)).toEqual([]);
  });

  it.each([
    [104_857_600, '100 MiB'],
    [1_048_576, '1 MiB'],
    [53_687_091_200, '50 GiB'],
    [1_610_612_736, '1536 MiB'],
    [262_144, '256 KiB'],
  ])('writes %i bytes as %s', (bytes, written) => {
    expect(describeBytes(bytes)).toBe(written);
  });
});
