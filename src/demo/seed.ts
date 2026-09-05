import type {
  FindingDetail,
  FindingStatus,
  Project,
  RegisterFindingInput,
} from '../core/types.js';
import { SecurityInboxService } from '../core/service.js';

type DemoProjectDefinition = {
  name: string;
  description: string;
  repositoryReference: string;
};

type DemoFindingDefinition = Omit<RegisterFindingInput, 'projectId'> & {
  projectName: string;
  targetStatus: FindingStatus;
};

export type DemoSeedResult = {
  projects: Project[];
  findings: FindingDetail[];
};

const projectDefinitions: DemoProjectDefinition[] = [
  {
    name: 'Security Inbox API',
    description: 'Synthetic API project for the local security inbox demo.',
    repositoryReference: 'demo://security-inbox-api',
  },
  {
    name: 'Security Inbox Web',
    description: 'Synthetic web project for the local security inbox demo.',
    repositoryReference: 'demo://security-inbox-web',
  },
];

const findingDefinitions: DemoFindingDefinition[] = [
  {
    projectName: 'Security Inbox API',
    idempotencyKey: 'demo-seed-critical-001',
    title: 'Synthetic SQL injection candidate',
    description: 'Synthetic input reaches a query construction path.',
    severity: 'critical',
    filePath: 'demo/api/query.ts',
    lineNumber: 18,
    commitRef: 'demo-commit-001',
    evidence: 'Synthetic evidence for the critical fixture.',
    recommendation: 'Use a parameterized query in the synthetic example.',
    origin: 'demo-seed',
    targetStatus: 'pending_review',
  },
  {
    projectName: 'Security Inbox API',
    idempotencyKey: 'demo-seed-high-002',
    title: 'Synthetic authorization gap',
    description: 'Synthetic route misses a role check in the example.',
    severity: 'high',
    filePath: 'demo/api/access.ts',
    lineNumber: 27,
    commitRef: 'demo-commit-002',
    evidence: 'Synthetic evidence for the high fixture.',
    recommendation: 'Add an explicit authorization check.',
    origin: 'demo-seed',
    targetStatus: 'confirmed',
  },
  {
    projectName: 'Security Inbox API',
    idempotencyKey: 'demo-seed-medium-003',
    title: 'Synthetic cookie configuration issue',
    description: 'Synthetic session cookie lacks a recommended flag.',
    severity: 'medium',
    filePath: 'demo/api/session.ts',
    lineNumber: 34,
    commitRef: 'demo-commit-003',
    evidence: 'Synthetic evidence for the medium fixture.',
    recommendation: 'Set the missing cookie flag.',
    origin: 'demo-seed',
    targetStatus: 'in_progress',
  },
  {
    projectName: 'Security Inbox Web',
    idempotencyKey: 'demo-seed-low-004',
    title: 'Synthetic response header omission',
    description: 'Synthetic response omits a low-impact header.',
    severity: 'low',
    filePath: 'demo/web/headers.ts',
    lineNumber: 12,
    commitRef: 'demo-commit-004',
    evidence: 'Synthetic evidence for the low fixture.',
    recommendation: 'Add the recommended response header.',
    origin: 'demo-seed',
    targetStatus: 'resolved',
  },
  {
    projectName: 'Security Inbox Web',
    idempotencyKey: 'demo-seed-info-005',
    title: 'Synthetic informational observation',
    description: 'Synthetic informational observation for review.',
    severity: 'informational',
    filePath: 'demo/web/config.ts',
    lineNumber: 9,
    commitRef: 'demo-commit-005',
    evidence: 'Synthetic evidence for the informational fixture.',
    recommendation: 'Keep the observation documented.',
    origin: 'demo-seed',
    targetStatus: 'dismissed',
  },
  {
    projectName: 'Security Inbox Web',
    idempotencyKey: 'demo-seed-high-006',
    title: 'Synthetic unsafe redirect candidate',
    description: 'Synthetic redirect input is not constrained in the example.',
    severity: 'high',
    filePath: 'demo/web/redirect.ts',
    lineNumber: 21,
    commitRef: 'demo-commit-006',
    evidence: 'Synthetic evidence for the second high fixture.',
    recommendation: 'Allow only known-safe redirect targets.',
    origin: 'demo-seed',
    targetStatus: 'confirmed',
  },
];

function ensureProject(service: SecurityInboxService, definition: DemoProjectDefinition): Project {
  const existing = service.listProjects().find(
    ({ repositoryReference }) => repositoryReference === definition.repositoryReference,
  );
  return existing ?? service.createProject(definition);
}

function ensureStatus(
  service: SecurityInboxService,
  finding: FindingDetail,
  targetStatus: FindingStatus,
): FindingDetail {
  if (finding.status === targetStatus) return finding;
  return service.updateFindingStatus({
    projectId: finding.projectId,
    findingId: finding.id,
    status: targetStatus,
    ...((targetStatus === 'resolved' || targetStatus === 'dismissed')
      ? { note: `Synthetic demo transition to ${targetStatus}.` }
      : {}),
  });
}

function ensureFinding(
  service: SecurityInboxService,
  project: Project,
  definition: DemoFindingDefinition,
): FindingDetail {
  const { projectName: _projectName, targetStatus: _targetStatus, ...fields } = definition;
  const input: RegisterFindingInput = { ...fields, projectId: project.id };
  const registered = service.registerFinding(input).finding;
  return ensureStatus(service, registered, definition.targetStatus);
}

export function seedDemo(databasePath?: string): DemoSeedResult {
  const service = new SecurityInboxService(databasePath);
  try {
    const projects = projectDefinitions.map((definition) => ensureProject(service, definition));
    const projectsByName = new Map(projects.map((project) => [project.name, project]));
    const findings = findingDefinitions.map((definition) => {
      const project = projectsByName.get(definition.projectName);
      if (!project) throw new Error(`Missing demo project: ${definition.projectName}`);
      return ensureFinding(service, project, definition);
    });
    return { projects, findings };
  } finally {
    service.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = seedDemo(process.env.SECURITY_INBOX_DB);
  process.stdout.write(`Seeded ${result.projects.length} projects and ${result.findings.length} findings.\n`);
}
