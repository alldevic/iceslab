import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { config } from './config.js';

// B4 - explicitly bound the connection pool. The cron fan-out (node-stats /
// metrics / status polls each Promise.all across every node, plus the queue
// workers) can otherwise spike concurrent queries and exhaust Postgres
// connections on a 2 GB / 1 vCPU box. Default 10; tune via DATABASE_POOL_MAX,
// which config.ts validates — see the note there for what an unvalidated one did.
const adapter = new PrismaPg({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
});

export const prisma = new PrismaClient({
  adapter,
  log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

export async function pingDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
