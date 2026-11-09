import crypto from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import type { FastifyRequest } from 'fastify';
import { pool } from './db';
import { HttpError } from './errors';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret';
export const ACCESS_TTL_SECONDS = 15 * 60;
export const SESSION_TTL_DAYS = 30;

export type Role = 'user' | 'store_manager' | 'superadmin';
export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
}

// stored as scrypt$<salt hex>$<hash hex>
export async function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function checkPassword(pw: string, stored: string) {
  const [, saltHex, hashHex] = stored.split('$');
  const hash = await scrypt(pw, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// compared against when the email is unknown, so a miss costs the same time as a wrong password
const DUMMY_HASH = 'scrypt$00000000000000000000000000000000$' + '0'.repeat(64);

export async function verifyLogin(email: string, password: string) {
  const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE lower(email) = lower($1)', [email]);
  const ok = await checkPassword(password, rows[0]?.password_hash ?? DUMMY_HASH);
  return ok && rows[0] ? (rows[0].id as number) : null;
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function tokensFor(userId: number, sessionId: string, secret: string) {
  return {
    accessToken: jwt.sign({ sid: sessionId }, JWT_SECRET, { subject: String(userId), expiresIn: ACCESS_TTL_SECONDS }),
    refreshToken: `${sessionId}.${secret}`,
    expiresIn: ACCESS_TTL_SECONDS,
  };
}

export async function createSession(userId: number) {
  const sessionId = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (id, user_id, refresh_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [sessionId, userId, sha256(secret), SESSION_TTL_DAYS],
  );
  return tokensFor(userId, sessionId, secret);
}

const unauthorized = () => new HttpError(401, 'unauthorized', 'Log in again');

// rotates the refresh token and slides the session expiry forward
export async function refreshSession(refreshToken: string) {
  const [sessionId, secret] = refreshToken.split('.');
  if (!sessionId || !secret || !/^[0-9a-f-]{36}$/.test(sessionId)) throw unauthorized();
  const next = crypto.randomBytes(32).toString('base64url');
  const { rows } = await pool.query(
    `UPDATE sessions SET refresh_hash = $3, expires_at = now() + make_interval(days => $4)
     WHERE id = $1 AND refresh_hash = $2 AND revoked_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [sessionId, sha256(secret), sha256(next), SESSION_TTL_DAYS],
  );
  if (!rows[0]) {
    // an old refresh token being replayed looks like theft, so kill the whole session
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
    throw unauthorized();
  }
  return tokensFor(Number(rows[0].user_id), sessionId, next);
}

export async function revokeSession(sessionId: string) {
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

// runs on every protected request: the JWT must be valid and its session still live
export async function authenticate(req: FastifyRequest) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(header.slice(7), JWT_SECRET) as jwt.JwtPayload;
  } catch {
    throw unauthorized();
  }
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [payload.sid, payload.sub],
  );
  if (!rows[0]) throw unauthorized();
  req.user = { ...rows[0], sessionId: payload.sid };
}
