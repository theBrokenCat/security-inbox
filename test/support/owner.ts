import type { SecurityInboxService } from '../../src/core/service.js';

// registerUser is idempotent by slug, so tests can call this wherever an owner is needed
// without threading a user through every helper.
export function testOwnerId(service: SecurityInboxService): string {
  return service.registerUser({ slug: 'tester', name: 'Tester' }).user.id;
}
