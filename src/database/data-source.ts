import { DataSource } from 'typeorm';
import { getDataSourceOptions } from './data-source-options.js';

export default new DataSource({
  ...getDataSourceOptions(),
  migrationsRun: false,
});
