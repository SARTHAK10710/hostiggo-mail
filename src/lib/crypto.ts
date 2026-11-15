import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ── Passwords (scrypt) ───────────────────────────────────────────────
const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, { ...SCRYPT, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(actual, expected);
}

// ── Token encryption at rest (AES-256-GCM, rotating keyring) ──────────
// Ciphertext format: v1.<keyId>.<iv>.<tag>.<data> (base64url parts).
// In production the keyring should be loaded from a KMS / secret manager.
export interface Keyring {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export function createKeyring(keys: { id: string; key: Buffer }[]): Keyring {
  const byId = new Map(keys.map((k) => [k.id, k.key]));
  const active = keys[0];
  return {
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', active.key, iv);
      cipher.setAAD(Buffer.from(active.id));
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return ['v1', active.id, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
    },
    decrypt(ciphertext) {
      const [v, keyId, iv, tag, data] = ciphertext.split('.');
      if (v !== 'v1') throw new Error('Unknown ciphertext version');
      const key = byId.get(keyId);
      if (!key) throw new Error(`Encryption key ${keyId} is not loaded`);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(keyId));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}

// ── Signed, purpose-bound tokens (unsubscribe links, OAuth state) ─────
export function signToken(payload: object, secret: string, purpose: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(`${purpose}.${body}`).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyToken<T>(token: string, secret: string, purpose: string): T | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(`${purpose}.${body}`).digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}
