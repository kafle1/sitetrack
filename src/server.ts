import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { pool } from './db';
import { migrate } from './migrate';
import { authenticate } from './auth';
import { HttpError } from './errors';
import authRoutes from './routes/auth';
import projectRoutes from './routes/projects';
import memberRoutes from './routes/members';
import taskRoutes from './routes/tasks';
import materialRoutes from './routes/materials';
import storeRoutes from './routes/store';
import deliveryRoutes from './routes/deliveries';

declare module 'fastify' {
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    ajv: { customOptions: { keywords: ['example'] } },
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'SiteTrack API',
        version: '1.0.0',
        description:
          'Every route except register, login and refresh needs `Authorization: Bearer <accessToken>`. ' +
          'Errors always look like `{ "error": "code", "message": "text" }`. ' +
          'Anything inside a project you are not a member of answers 404, the same as a project that does not exist.',
      },
      components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
      security: [{ bearer: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.addHook('onRequest', async (req) => {
    if (req.routeOptions.config?.public || req.url.startsWith('/docs')) return;
    await authenticate(req);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err.validation) return reply.status(400).send({ error: 'bad_request', message: err.message });
    // a CHECK constraint is the last line of defence for stock
    if (err.code === '23514') return reply.status(409).send({ error: 'constraint', message: 'That change would break a data rule' });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: 'bad_request', message: err.message });
    req.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong' });
  });

  app.get('/health', { config: { public: true }, schema: { hide: true } }, async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  await app.register(authRoutes);
  await app.register(projectRoutes);
  await app.register(memberRoutes);
  await app.register(taskRoutes);
  await app.register(materialRoutes);
  await app.register(storeRoutes);
  await app.register(deliveryRoutes);
  return app;
}

async function main() {
  const app = await buildApp();
  // the db container can report healthy a moment before it accepts our login
  for (let i = 0; ; i++) {
    try {
      await migrate((m) => app.log.info(m));
      break;
    } catch (e) {
      if (i >= 30) throw e;
      app.log.warn(`database not ready, retrying: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await app.listen({ port: Number(process.env.PORT ?? 8080), host: '0.0.0.0' });
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
