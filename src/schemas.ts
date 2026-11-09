// shared JSON schema pieces; they drive validation and the OpenAPI docs

export const str = { type: 'string' } as const;
export const int = { type: 'integer' } as const;
export const num = { type: 'number' } as const;
export const bool = { type: 'boolean' } as const;
export const date = { type: 'string', format: 'date', example: '2026-11-09' } as const;
export const dateTime = { type: 'string', format: 'date-time' } as const;
export const nullable = (s: object) => ({ ...s, nullable: true });
export const arr = (items: object) => ({ type: 'array', items }) as const;
export const obj = (properties: Record<string, object>, required: string[] = Object.keys(properties)) =>
  ({ type: 'object', properties, required, additionalProperties: false }) as const;
export const strEnum = (values: string[]) => ({ type: 'string', enum: values }) as const;

export const pageQuery = {
  page: { type: 'integer', minimum: 1, default: 1 },
  pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
};

export const paged = (item: object) =>
  obj({ items: arr(item), page: int, pageSize: int, total: int });

export const userRef = nullable(obj({ id: int, name: str }));

export const errorBody = obj({ error: str, message: str });

export const ok = obj({ ok: bool });

export const projectIdParam = obj({ projectId: { type: 'string', example: 'PRJ-0042' } });

export function pageOf(q: { page: number; pageSize: number }) {
  return { limit: q.pageSize, offset: (q.page - 1) * q.pageSize };
}
