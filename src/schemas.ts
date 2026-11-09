// shared JSON schema pieces; they drive validation and the OpenAPI docs

export const str = { type: 'string' } as const;
export const int = { type: 'integer' } as const;
// ids in paths and bodies; a number past Postgres integer range is a bad request, not a database error
export const idIn = { type: 'integer', maximum: 2147483647 } as const;
// \S so a name of only spaces doesn't trim down to an empty one
export const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' }) as const;
export const num = { type: 'number' } as const;
export const bool = { type: 'boolean' } as const;
export const date = { type: 'string', format: 'date', example: '2026-11-09' } as const;
export const dateTime = { type: 'string', format: 'date-time' } as const;
export const nullable = (s: object) => ({ ...s, nullable: true });
export const arr = (items: object) => ({ type: 'array', items }) as const;
export const obj = (properties: Record<string, object>, required: string[] = Object.keys(properties)) =>
  ({ type: 'object', properties, required, additionalProperties: false }) as const;
export const strEnum = (values: readonly string[]) => ({ type: 'string', enum: values }) as const;

export const pageQuery = {
  page: { type: 'integer', minimum: 1, maximum: 1000000, default: 1 },
  pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
};

export const paged = (item: object) =>
  obj({ items: arr(item), page: int, pageSize: int, total: int });

export const userRef = nullable(obj({ id: int, name: str }));
export const ref = (id: number | null, name: string | null) => (id ? { id, name: name! } : null);

export const errorBody = obj({ error: str, message: str });

export const ok = obj({ ok: bool });

export const order = { ...strEnum(['asc', 'desc']), default: 'asc' };

// stock is kept to 3 decimals; server.ts sets the ajv precision that lets 1.001 pass multipleOf
export const quantity = { type: 'number', minimum: 0.001, maximum: 1e9, multipleOf: 0.001 } as const;

export const projectIdField = { type: 'string', example: 'PRJ-0042' } as const;
// path params of every route under a project, plus whatever the nested route adds
export const projectIdParam = (more: Record<string, object> = {}) => obj({ projectId: projectIdField, ...more });
