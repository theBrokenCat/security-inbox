import { SecurityInboxService } from '../../src/core/service.js';

const [databasePath, inputJson] = process.argv.slice(2);
if (!databasePath || !inputJson) throw new Error('database path and input are required');

const service = new SecurityInboxService(databasePath);
try {
  const result = service.registerFinding(JSON.parse(inputJson));
  process.stdout.write(JSON.stringify({ created: result.created, id: result.finding.id }));
} finally {
  service.close();
}
