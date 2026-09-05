import type { FindingDetail, RegisterFindingInput } from '../core/types.js';
import { SecurityInboxService } from '../core/service.js';
import { seedDemo } from './seed.js';

export type DemoRunResult = {
  projectId: string;
  findingId: string;
  firstCreated: boolean;
  retryCreated: boolean;
  historyLength: number;
  reopenedHistoryLength: number;
};

const demoNote = 'Synthetic demo transition verified.';

function assertRoute(first: FindingDetail, retry: FindingDetail, retryCreated: boolean): void {
  if (retryCreated || first.id !== retry.id) {
    throw new Error('Demo retry did not return the original finding');
  }
}

export function runDemo(databasePath?: string): DemoRunResult {
  const seeded = seedDemo(databasePath);
  const project = seeded.projects[0];
  if (!project) throw new Error('Demo seed did not create a project');

  const input: RegisterFindingInput = {
    projectId: project.id,
    idempotencyKey: 'demo-route-fixed-key',
    title: 'Synthetic selected finding',
    description: 'Synthetic finding used to verify the shared service route.',
    severity: 'high',
    filePath: 'demo/route.ts',
    lineNumber: 7,
    commitRef: 'demo-route-commit',
    evidence: 'Synthetic evidence for the shared route.',
    recommendation: 'Keep the route covered by the shared service.',
    origin: 'demo-route',
  };

  let firstCreated: boolean;
  let retryCreated: boolean;
  let finding: FindingDetail;
  let historyLength: number;
  const service = new SecurityInboxService(databasePath);
  try {
    const first = service.registerFinding(input);
    const retry = service.registerFinding(input);
    assertRoute(first.finding, retry.finding, retry.created);
    firstCreated = first.created;
    retryCreated = retry.created;
    finding = retry.finding;

    if (finding.status === 'pending_review') {
      finding = service.updateFindingStatus({
        projectId: project.id,
        findingId: finding.id,
        status: 'confirmed',
        note: demoNote,
      });
    }
    if (!finding.history.some(({ kind, note }) => kind === 'status_changed' && note === demoNote)) {
      throw new Error('Demo transition note is missing from history');
    }
    historyLength = finding.history.length;
  } finally {
    service.close();
  }

  const reopened = new SecurityInboxService(databasePath);
  let reopenedHistoryLength: number;
  try {
    const restored = reopened.getFinding({ projectId: project.id, findingId: finding!.id });
    if (!restored.history.some(({ kind, note }) => kind === 'status_changed' && note === demoNote)) {
      throw new Error('Demo transition note did not survive reopen');
    }
    reopenedHistoryLength = restored.history.length;
  } finally {
    reopened.close();
  }

  return {
    projectId: project.id,
    findingId: finding!.id,
    firstCreated: firstCreated!,
    retryCreated: retryCreated!,
    historyLength: historyLength!,
    reopenedHistoryLength,
  };
}

const invokedPath = process.argv[1] ? new URL(process.argv[1], 'file:').href : '';
if (import.meta.url === invokedPath) {
  const result = runDemo(process.env.SECURITY_INBOX_DB);
  process.stdout.write(
    `Demo verified project ${result.projectId}, finding ${result.findingId}; `
      + `retryCreated=${result.retryCreated}, history=${result.reopenedHistoryLength}.\n`,
  );
}
