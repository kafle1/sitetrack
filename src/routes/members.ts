import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { pool, tx } from '../db';
import { projectAccess, projectAdmin } from '../access';
import { conflict, forbidden, notFound } from '../errors';
import { projectCode } from '../ids';
import { arr, bool, dateTime, errorBody, idIn, int, nullable, obj, ok, pageOf, pageQuery, str, strEnum, userRef } from '../schemas';

const projectParams = obj({ projectId: { type: 'string', example: 'PRJ-0042' } });

const member = obj({ userId: int, name: str, email: str, isAdmin: bool, joinedAt: dateTime });
const pendingInvitation = obj({ id: int, user: obj({ id: int, name: str, email: str }), invitedBy: userRef, createdAt: dateTime });
const notification = obj({
  id: int,
  type: strEnum(['project_invitation']),
  project: nullable(obj({ id: str, name: str })),
  invitedBy: userRef,
  status: strEnum(['pending', 'accepted', 'rejected']),
  read: bool,
  createdAt: dateTime,
  answeredAt: nullable(dateTime),
});

async function membersOf(projectId: number) {
  const [m, i] = await Promise.all([
    pool.query(
      `SELECT u.id, u.name, u.email, pm.is_admin, pm.joined_at FROM project_members pm JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1 ORDER BY pm.is_admin DESC, u.name`,
      [projectId],
    ),
    pool.query(
      `SELECT i.id, i.created_at, u.id AS user_id, u.name, u.email, b.id AS by_id, b.name AS by_name
       FROM invitations i JOIN users u ON u.id = i.user_id LEFT JOIN users b ON b.id = i.invited_by
       WHERE i.project_id = $1 AND i.status = 'pending' ORDER BY i.created_at DESC`,
      [projectId],
    ),
  ]);
  return {
    members: m.rows.map((r) => ({ userId: r.id, name: r.name, email: r.email, isAdmin: r.is_admin, joinedAt: r.joined_at })),
    invitations: i.rows.map((r) => ({
      id: r.id,
      user: { id: r.user_id, name: r.name, email: r.email },
      invitedBy: r.by_id ? { id: r.by_id, name: r.by_name } : null,
      createdAt: r.created_at,
    })),
  };
}

const membersResponse = obj({ members: arr(member), invitations: arr(pendingInvitation) });

export default async function memberRoutes(app: FastifyInstance) {
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/members',
    {
      schema: {
        tags: ['members'],
        summary: 'Members screen: members (admins first) and invitations not yet answered',
        params: projectParams,
        response: { 200: membersResponse, 404: errorBody },
      },
    },
    async (req) => {
      const { projectId } = await projectAccess(pool, req.user, req.params.projectId);
      return membersOf(projectId);
    },
  );

  app.post<{ Params: { projectId: string }; Body: { email: string } }>(
    '/projects/:projectId/invitations',
    {
      schema: {
        tags: ['members'],
        summary: 'Invite a registered user by email (project admins)',
        params: projectParams,
        body: obj({ email: { type: 'string', maxLength: 320 } }),
        response: { 201: membersResponse, 403: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (req, reply) => {
      const { projectId } = await projectAdmin(pool, req.user, req.params.projectId);
      const { rows } = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [req.body.email.trim()]);
      if (!rows[0]) throw notFound('No registered user has that email');
      const userId = rows[0].id;
      const { rows: inserted } = await pool.query(
        `INSERT INTO invitations (project_id, user_id, invited_by)
         SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2)
         ON CONFLICT DO NOTHING RETURNING id`,
        [projectId, userId, req.user.id],
      );
      if (!inserted[0]) throw conflict('already_member_or_invited', 'That person is already a member or already has an open invitation');
      return reply.status(201).send(await membersOf(projectId));
    },
  );

  app.delete<{ Params: { projectId: string; invitationId: number } }>(
    '/projects/:projectId/invitations/:invitationId',
    {
      schema: {
        tags: ['members'],
        summary: 'Withdraw an invitation that has not been answered (project admins)',
        params: obj({ projectId: str, invitationId: idIn }),
        response: { 200: membersResponse, 403: errorBody, 404: errorBody },
      },
    },
    async (req) => {
      const { projectId } = await projectAdmin(pool, req.user, req.params.projectId);
      const { rowCount } = await pool.query(
        `UPDATE invitations SET status = 'withdrawn', answered_at = now() WHERE id = $1 AND project_id = $2 AND status = 'pending'`,
        [req.params.invitationId, projectId],
      );
      if (!rowCount) throw notFound('No open invitation with that ID');
      return membersOf(projectId);
    },
  );

  app.patch<{ Params: { projectId: string; userId: number }; Body: { isAdmin: boolean } }>(
    '/projects/:projectId/members/:userId',
    {
      schema: {
        tags: ['members'],
        summary: 'Make a member a project admin, or take admin away (project admins)',
        description: 'Taking admin from the last project admin is refused with 409.',
        params: obj({ projectId: str, userId: idIn }),
        body: obj({ isAdmin: bool }),
        response: { 200: membersResponse, 403: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (req) => {
      const projectId = await tx(async (c) => {
        // checked under the lock, so two admins demoting each other at the same moment can't both pass
        const { projectId } = await projectAdmin(c, req.user, req.params.projectId, true);
        const { rowCount } = await c.query('UPDATE project_members SET is_admin = $3 WHERE project_id = $1 AND user_id = $2', [
          projectId,
          req.params.userId,
          req.body.isAdmin,
        ]);
        if (!rowCount) throw notFound('That person is not a member');
        await ensureAnAdmin(c, projectId);
        return projectId;
      });
      return membersOf(projectId);
    },
  );

  app.delete<{ Params: { projectId: string; userId: number } }>(
    '/projects/:projectId/members/:userId',
    {
      schema: {
        tags: ['members'],
        summary: 'Remove a member (project admins), or leave the project yourself',
        description: 'Removing the last project admin is refused with 409. The removed person loses access on their next request.',
        params: obj({ projectId: str, userId: idIn }),
        response: { 200: ok, 403: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (req) => {
      await tx(async (c) => {
        const access = await projectAccess(c, req.user, req.params.projectId, true);
        if (!access.isAdmin && req.params.userId !== req.user.id) throw forbidden('Only project admins can remove members');
        const { rowCount } = await c.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [
          access.projectId,
          req.params.userId,
        ]);
        if (!rowCount) throw notFound('That person is not a member');
        await ensureAnAdmin(c, access.projectId);
      });
      return { ok: true };
    },
  );

  app.get<{ Querystring: { page: number; pageSize: number } }>(
    '/notifications',
    {
      schema: {
        tags: ['notifications'],
        summary: 'My notifications (project invitations), newest first, with the unread count',
        querystring: { type: 'object', properties: pageQuery },
        response: { 200: obj({ items: arr(notification), unreadCount: int, page: int, pageSize: int, total: int }) },
      },
    },
    async (req) => {
      const { limit, offset } = pageOf(req.query);
      const [list, counts] = await Promise.all([
        pool.query(
          `SELECT i.id, i.status, i.read_at, i.created_at, i.answered_at, p.id AS project_id, p.name AS project_name,
             b.id AS by_id, b.name AS by_name
           FROM invitations i LEFT JOIN projects p ON p.id = i.project_id LEFT JOIN users b ON b.id = i.invited_by
           WHERE i.user_id = $1 AND i.status <> 'withdrawn'
           ORDER BY i.created_at DESC, i.id DESC LIMIT $2 OFFSET $3`,
          [req.user.id, limit, offset],
        ),
        pool.query(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE read_at IS NULL)::int AS unread
           FROM invitations WHERE user_id = $1 AND status <> 'withdrawn'`,
          [req.user.id],
        ),
      ]);
      return {
        items: list.rows.map((r) => ({
          id: r.id,
          type: 'project_invitation',
          project: r.project_id ? { id: projectCode(r.project_id), name: r.project_name } : null,
          invitedBy: r.by_id ? { id: r.by_id, name: r.by_name } : null,
          status: r.status,
          read: r.read_at !== null,
          createdAt: r.created_at,
          answeredAt: r.answered_at,
        })),
        unreadCount: counts.rows[0].unread,
        page: req.query.page,
        pageSize: req.query.pageSize,
        total: counts.rows[0].total,
      };
    },
  );

  app.get(
    '/notifications/unread-count',
    { schema: { tags: ['notifications'], summary: 'Unread notification count, for the badge on every page', response: { 200: obj({ unreadCount: int }) } } },
    async (req) => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM invitations WHERE user_id = $1 AND read_at IS NULL AND status <> 'withdrawn'`,
        [req.user.id],
      );
      return { unreadCount: rows[0].n };
    },
  );

  app.post<{ Body: { ids?: number[] } }>(
    '/notifications/read',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Mark notifications as read: send { "ids": [...] } for some, or {} for all of them',
        body: { type: 'object', properties: { ids: { type: 'array', items: idIn, maxItems: 500 } } },
        response: { 200: obj({ unreadCount: int }) },
      },
    },
    async (req) => {
      const ids = req.body?.ids;
      await pool.query(
        `UPDATE invitations SET read_at = now() WHERE user_id = $1 AND read_at IS NULL ${ids ? 'AND id = ANY($2)' : ''}`,
        ids ? [req.user.id, ids] : [req.user.id],
      );
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM invitations WHERE user_id = $1 AND read_at IS NULL AND status <> 'withdrawn'`,
        [req.user.id],
      );
      return { unreadCount: rows[0].n };
    },
  );

  for (const answer of ['accept', 'reject'] as const) {
    app.post<{ Params: { invitationId: number } }>(
      `/invitations/:invitationId/${answer}`,
      {
        schema: {
          tags: ['notifications'],
          summary: answer === 'accept' ? 'Accept my invitation and join the project' : 'Reject my invitation',
          description: 'Only the invited person can answer. Anyone else gets 404.',
          params: obj({ invitationId: idIn }),
          response: { 200: ok, 404: errorBody, 409: errorBody },
        },
      },
      async (req) => {
        await tx(async (c) => {
          const { rows } = await c.query(
            `UPDATE invitations SET status = $3, answered_at = now(), read_at = coalesce(read_at, now())
             WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING project_id`,
            [req.params.invitationId, req.user.id, answer === 'accept' ? 'accepted' : 'rejected'],
          );
          if (!rows[0]) {
            const mine = await c.query('SELECT status FROM invitations WHERE id = $1 AND user_id = $2', [req.params.invitationId, req.user.id]);
            if (mine.rows[0]) throw conflict('already_answered', `This invitation is already ${mine.rows[0].status}`);
            throw notFound('Invitation not found');
          }
          if (answer === 'accept')
            await c.query('INSERT INTO project_members (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [rows[0].project_id, req.user.id]);
        });
        return { ok: true };
      },
    );
  }
}

async function ensureAnAdmin(c: PoolClient, projectId: number) {
  const { rows } = await c.query('SELECT count(*)::int AS n FROM project_members WHERE project_id = $1 AND is_admin', [projectId]);
  if (rows[0].n === 0) throw conflict('last_admin', 'A project must always have at least one project admin');
}

