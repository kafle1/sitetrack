import type { AuthUser } from './auth';
import type { Db } from './db';
import { forbidden, notFound } from './errors';
import { parseProjectId } from './ids';

export interface ProjectAccess {
  projectId: number;
  isMember: boolean;
  isAdmin: boolean;
}

const PROJECT_NOT_FOUND = 'Project not found';

// read from the database on every request, so a removal or role change bites on the very next call.
// lock reads it under the project lock, so a member demoted or removed a moment ago can't still act.
export async function projectAccess(db: Db, user: AuthUser, projectParam: string, lock = false): Promise<ProjectAccess> {
  const projectId = parseProjectId(projectParam);
  if (projectId === null) throw notFound(PROJECT_NOT_FOUND);
  if (lock) await lockProject(db, projectId);
  const { rows } = await db.query(
    `SELECT pm.is_admin FROM projects p
     LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
     WHERE p.id = $1`,
    [projectId, user.id],
  );
  const row = rows[0];
  const isMember = row?.is_admin !== undefined && row?.is_admin !== null;
  if (user.role === 'superadmin' && row) return { projectId, isMember, isAdmin: true };
  // a non-member gets the exact same answer as a project that does not exist
  if (!isMember) throw notFound(PROJECT_NOT_FOUND);
  return { projectId, isMember, isAdmin: row.is_admin };
}

export async function projectAdmin(db: Db, user: AuthUser, projectParam: string, lock = false) {
  const access = await projectAccess(db, user, projectParam, lock);
  if (!access.isAdmin) throw forbidden('Only project admins can do this');
  return access;
}

export const canUseCompanyStore = (user: AuthUser) => user.role === 'store_manager' || user.role === 'superadmin';

export function requireCompanyStore(user: AuthUser) {
  if (!canUseCompanyStore(user)) throw forbidden('Only company store managers can use the company store');
}

// serialises writes that need a consistent view of one project's tasks and members
export async function lockProject(db: Db, projectId: number) {
  await db.query('SELECT 1 FROM projects WHERE id = $1 FOR NO KEY UPDATE', [projectId]);
}
