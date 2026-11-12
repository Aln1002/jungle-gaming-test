import { ConfigModule } from '@nestjs/config';
import {
  configuration,
  getEnvironmentFilePaths,
} from '../config/env/configuration.js';

const command = process.argv[2];
if (command !== 'run' && command !== 'revert') {
  throw new Error('Usage: bun scripts/migrate.ts <run|revert>');
}

await ConfigModule.forRoot({
  envFilePath: getEnvironmentFilePaths(),
  load: [configuration],
});
const { default: dataSource } = await import('../src/database/data-source.js');

try {
  await dataSource.initialize();
  if (command === 'run') {
    const migrations = await dataSource.runMigrations();
    console.log(`Applied ${migrations.length} migration(s)`);
  } else {
    await dataSource.undoLastMigration();
    console.log('Migration revert command completed');
  }
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'database_migration_failed',
      errorType: error instanceof Error ? error.name : 'UnknownError',
    }),
  );
  process.exitCode = 1;
} finally {
  if (dataSource.isInitialized) {
    await dataSource.destroy();
  }
}
