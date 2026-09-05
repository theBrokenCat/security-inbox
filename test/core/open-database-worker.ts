import { openDatabase } from '../../src/storage/database.js';

const [databasePath] = process.argv.slice(2);
if (!databasePath) throw new Error('database path is required');

openDatabase(databasePath).close();
