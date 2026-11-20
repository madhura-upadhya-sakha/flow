import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
function derive(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const key = await derive(password, salt);
  return `${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored?: string) {
  const computed = await hashPassword(password, stored?.split(':')[0] ?? 'flow-unused-credential');
  return Boolean(stored && computed.length === stored.length &&
    timingSafeEqual(Buffer.from(computed), Buffer.from(stored)));
}
