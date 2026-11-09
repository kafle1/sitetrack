import type { FastifyInstance } from 'fastify';
import { pool } from '../db';
import { createSession, hashPassword, refreshSession, revokeSession, verifyLogin } from '../auth';
import { HttpError, conflict } from '../errors';
import { errorBody, int, obj, ok, str, strEnum } from '../schemas';

const tokens = obj({ accessToken: str, refreshToken: str, expiresIn: int });
const me = obj({ id: int, name: str, email: str, role: strEnum(['user', 'store_manager', 'superadmin']), unreadNotifications: int });

export default async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { name: string; email: string; password: string; role: string } }>(
    '/auth/register',
    {
      config: { public: true },
      schema: {
        tags: ['auth'],
        summary: 'Register a new account and log in',
        security: [],
        body: obj({
          name: { type: 'string', minLength: 1, maxLength: 200 },
          email: { type: 'string', format: 'email', maxLength: 320 },
          password: { type: 'string', minLength: 8, maxLength: 200 },
          role: strEnum(['user', 'store_manager', 'superadmin']),
        }),
        response: { 201: tokens, 409: errorBody },
      },
    },
    async (req, reply) => {
      const { name, email, password, role } = req.body;
      const hash = await hashPassword(password);
      const { rows } = await pool.query(
        `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING RETURNING id`,
        [name.trim(), email.trim(), hash, role],
      );
      if (!rows[0]) throw conflict('email_taken', 'That email is already registered');
      return reply.status(201).send(await createSession(Number(rows[0].id)));
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    {
      config: { public: true },
      schema: {
        tags: ['auth'],
        summary: 'Log in with email and password',
        description: 'A wrong email and a wrong password give the same 401 answer.',
        security: [],
        body: obj({ email: { type: 'string', maxLength: 320 }, password: { type: 'string', maxLength: 200 } }),
        response: { 200: tokens, 401: errorBody },
      },
    },
    async (req) => {
      const userId = await verifyLogin(req.body.email.trim(), req.body.password);
      if (!userId) throw new HttpError(401, 'invalid_credentials', 'Email or password is wrong');
      return createSession(userId);
    },
  );

  app.post<{ Body: { refreshToken: string } }>(
    '/auth/refresh',
    {
      config: { public: true },
      schema: {
        tags: ['auth'],
        summary: 'Swap a refresh token for a new access token and a new refresh token',
        description: 'Access tokens last 15 minutes. Each refresh token works once and keeps the session alive for 30 more days.',
        security: [],
        body: obj({ refreshToken: { type: 'string', maxLength: 500 } }),
        response: { 200: tokens, 401: errorBody },
      },
    },
    async (req) => refreshSession(req.body.refreshToken),
  );

  app.post(
    '/auth/logout',
    { schema: { tags: ['auth'], summary: 'End the current session', response: { 200: ok } } },
    async (req) => {
      await revokeSession(req.user.sessionId);
      return { ok: true };
    },
  );

  app.get('/me', { schema: { tags: ['auth'], summary: 'My profile and unread notification count', response: { 200: me } } }, async (req) => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM invitations WHERE user_id = $1 AND read_at IS NULL AND status <> 'withdrawn'`,
      [req.user.id],
    );
    const { id, name, email, role } = req.user;
    return { id, name, email, role, unreadNotifications: rows[0].n };
  });
}
