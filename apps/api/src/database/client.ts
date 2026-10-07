import { PrismaClient } from '@prisma/client';
import '../config/environment';

// Todos los controladores comparten el mismo pool de conexiones de PostgreSQL.
export const db = new PrismaClient();
