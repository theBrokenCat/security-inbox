export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FINDING_STATUSES = [
  'pending_review',
  'confirmed',
  'in_progress',
  'resolved',
  'dismissed',
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export type FindingEventKind = 'created' | 'edited' | 'status_changed' | 'note';

export const USER_COLORS = ['violeta', 'turquesa', 'ambar', 'coral', 'indigo', 'jade'] as const;
export type UserColor = (typeof USER_COLORS)[number];

export const PROJECT_SCOPES = ['mine', 'all'] as const;
export type ProjectScope = (typeof PROJECT_SCOPES)[number];

export type Scalar = string | number | null;
export type FieldChange = { from: Scalar; to: Scalar };

export type User = {
  id: string;
  slug: string;
  name: string;
  color: UserColor;
  createdAt: string;
};
export type CreateUserInput = {
  slug: string;
  name?: string;
  color?: UserColor;
};
export type RegisterUserResult = { user: User; created: boolean };

export type Project = {
  id: string;
  name: string;
  description: string;
  repositoryReference: string | null;
  directoryPath: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};
export type SeverityCounts = Record<Severity, number>;
export type ProjectSummary = Project & {
  owner: User;
  openCounts: SeverityCounts;
  openTotal: number;
  pendingReviewCount: number;
  worstOpenSeverity: Severity | null;
};
export type ListProjectsInput = {
  scope?: ProjectScope;
  ownerId?: string;
};
export type CreateProjectInput = {
  name: string;
  description: string;
  repositoryReference?: string | null;
  ownerId: string;
};
export type ResolvedProjectDirectoryInput = {
  name: string;
  description: string;
  directoryPath: string;
  ownerId: string;
};
export type RegisterProjectDirectoryResult = { project: Project; created: boolean };

export type DirectoryEntry = {
  name: string;
  relativePath: string;
  displayPath: string;
};
export type DirectoryListing = {
  rootDisplayPath: string;
  relativePath: string;
  displayPath: string;
  parentRelativePath: string | null;
  directories: DirectoryEntry[];
};
export type RegisterProjectDirectoryInput = {
  relativePath: string;
  description?: string | null;
  ownerId: string;
};

export type Finding = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  severity: Severity;
  status: FindingStatus;
  filePath: string | null;
  lineNumber: number | null;
  commitRef: string | null;
  evidence: string;
  recommendation: string | null;
  origin: string;
  createdAt: string;
  updatedAt: string;
};
export type FindingSummary = Pick<
  Finding,
  | 'id'
  | 'projectId'
  | 'title'
  | 'severity'
  | 'status'
  | 'origin'
  | 'filePath'
  | 'lineNumber'
  | 'updatedAt'
>;
export type FindingEvent = {
  id: string;
  findingId: string;
  kind: FindingEventKind;
  fromStatus: FindingStatus | null;
  toStatus: FindingStatus | null;
  note: string | null;
  changes: Record<string, FieldChange> | null;
  createdAt: string;
};
export type FindingDetail = Finding & { history: FindingEvent[] };
export type FindingIdentity = { projectId: string; findingId: string };

export type RegisterFindingInput = {
  projectId: string;
  idempotencyKey: string;
  title: string;
  description: string;
  severity: Severity;
  filePath?: string | null;
  lineNumber?: number | null;
  commitRef?: string | null;
  evidence: string;
  recommendation?: string | null;
  origin: string;
};
export type EditableFindingFields = {
  title?: string;
  description?: string;
  severity?: Severity;
  filePath?: string | null;
  lineNumber?: number | null;
  commitRef?: string | null;
  evidence?: string;
  recommendation?: string | null;
  origin?: string;
  note?: string | null;
};
export type ListFindingsInput = {
  projectId: string;
  severity?: Severity;
  status?: FindingStatus;
  query?: string;
  limit?: number;
};
export type DuplicateCandidate = Pick<
  Finding,
  'id' | 'projectId' | 'title' | 'severity' | 'status' | 'updatedAt'
> & { match: 'exact' | 'similar'; score: number };
export type RegisterFindingResult = {
  finding: FindingDetail;
  created: boolean;
  possibleDuplicates: DuplicateCandidate[];
};

export type AppErrorCode =
  | 'VALIDATION_ERROR'
  | 'PROJECT_NOT_FOUND'
  | 'FINDING_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'TERMINAL_NOTE_REQUIRED'
  | 'NO_STATUS_CHANGE'
  | 'DIRECTORY_INVALID'
  | 'DIRECTORY_UNAVAILABLE'
  | 'USER_NOT_FOUND'
  | 'USER_REQUIRED';
export type PublicAppError = {
  code: AppErrorCode;
  message: string;
  fieldErrors?: Record<string, string[]>;
};
