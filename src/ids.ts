const pad = (n: number) => String(n).padStart(4, '0');

export const projectCode = (n: number) => `PRJ-${pad(n)}`;
export const taskCode = (projectId: number, n: number) => `${projectCode(projectId)}-T-${pad(n)}`;

export function parseProjectId(s: string): number | null {
  const m = /^PRJ-(\d{4,9})$/i.exec(s);
  return m ? Number(m[1]) : null;
}

// accepts the full code (PRJ-0042-T-0137) or just the task number
export function parseTaskNumber(s: string, projectId: number): number | null {
  const m = /^(?:PRJ-(\d{4,9})-T-)?(\d{1,9})$/i.exec(s);
  if (!m) return null;
  if (m[1] && Number(m[1]) !== projectId) return null;
  return Number(m[2]);
}

// "PRJ-0042", "0042" and "42" all mean project 42 in a search box
export function searchNumber(q: string, prefix: RegExp): number | null {
  const m = new RegExp(`^(?:${prefix.source})?0*(\\d{1,9})$`, 'i').exec(q.trim());
  return m ? Number(m[1]) : null;
}
