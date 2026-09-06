import { SecurityInboxService } from '../../src/core/service.js';

const [databasePath, serializedInput] = process.argv.slice(2);
if (!databasePath || !serializedInput) throw new Error('database path and input are required');

const service = new SecurityInboxService(databasePath);
try {
  const result = service.registerProjectDirectory({
    ...JSON.parse(serializedInput),
    ownerId: service.registerUser({ slug: 'tester', name: 'Tester' }).user.id,
  });
  process.stdout.write(JSON.stringify({ created: result.created, id: result.project.id }));
} finally {
  service.close();
}
