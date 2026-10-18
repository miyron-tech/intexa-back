import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { User } from '../users/entities/user.entity.js';
import { RefreshToken } from '../auth/entities/refresh-token.entity.js';
import { GenerationJob } from '../generation/entities/generation-job.entity.js';

export function buildDataSourceOptions(databaseUrl: string): DataSourceOptions {
  return {
    type: 'postgres',
    url: databaseUrl,
    entities: [User, RefreshToken, GenerationJob],
    // Миграции берутся из собранного dist — так не нужен ts-node для CLI
    migrations: [new URL('./migrations/*.js', import.meta.url).pathname],
    synchronize: false,
    // gen_random_uuid() встроена в Postgres 13+, расширение uuid-ossp не нужно
    uuidExtension: 'pgcrypto',
  };
}

// Используется CLI TypeORM: npm run migration:generate / migration:run
export default new DataSource(
  buildDataSourceOptions(
    process.env.DATABASE_URL ??
      'postgres://aigenerate:aigenerate@localhost:5435/aigenerate',
  ),
);
