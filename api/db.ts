import { MikroORM, type EntityManager } from "@mikro-orm/postgresql";
import config from "../mikro-orm.config.js";

let orm: MikroORM | null = null;

export async function initDb(): Promise<MikroORM> {
  if (orm) return orm;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL is not configured.");
  }
  orm = await MikroORM.init(config);
  const ok = await orm.isConnected();
  if (!ok) {
    throw new Error("Postgres is not reachable.");
  }
  return orm;
}

export function em(): EntityManager {
  if (!orm) {
    throw new Error("Database is not initialized.");
  }
  return orm.em.fork();
}
