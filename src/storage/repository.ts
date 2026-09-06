import type {
  Finding,
  FindingDetail,
  FindingEvent,
  FindingStatus,
  FindingSummary,
  ListFindingsInput,
  ListProjectsInput,
  Project,
  ProjectSummary,
  Severity,
  SeverityCounts,
  User,
  UserColor,
} from '../core/types.js';
import { SEVERITIES } from '../core/types.js';
import type { SqliteDatabase } from './database.js';

type UserRow = {
  id: string;
  slug: string;
  name: string;
  color: UserColor;
  created_at: string;
};

type ProjectRow = {
  id: string;
  name: string;
  description: string;
  repository_reference: string | null;
  directory_path: string | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
};

type ProjectSummaryRow = ProjectRow & {
  owner_slug: string;
  owner_name: string;
  owner_color: UserColor;
  owner_created_at: string;
  critical_count: number;
  high_count: number;
  medium_count: number;
  low_count: number;
  informational_count: number;
  open_total: number;
  pending_review_count: number;
};

type FindingRow = {
  id: string;
  project_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  title: string;
  normalized_title: string;
  description: string;
  severity: Severity;
  status: FindingStatus;
  file_path: string | null;
  line_number: number | null;
  commit_ref: string | null;
  evidence: string;
  recommendation: string | null;
  origin: string;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  id: string;
  finding_id: string;
  kind: FindingEvent['kind'];
  from_status: FindingStatus | null;
  to_status: FindingStatus | null;
  note: string | null;
  changes_json: string | null;
  created_at: string;
};

export type StoredFinding = Finding & {
  idempotencyKey: string;
  requestFingerprint: string;
  normalizedTitle: string;
};

export type DuplicateRow = Pick<
  Finding,
  'id' | 'projectId' | 'title' | 'severity' | 'status' | 'updatedAt'
> & { normalizedTitle: string };

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    repositoryReference: row.repository_reference,
    directoryPath: row.directory_path,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
  };
}

function worstOpenSeverity(counts: SeverityCounts): Severity | null {
  return SEVERITIES.find((severity) => counts[severity] > 0) ?? null;
}

function toFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    severity: row.severity,
    status: row.status,
    filePath: row.file_path,
    lineNumber: row.line_number,
    commitRef: row.commit_ref,
    evidence: row.evidence,
    recommendation: row.recommendation,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: EventRow): FindingEvent {
  return {
    id: row.id,
    findingId: row.finding_id,
    kind: row.kind,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    note: row.note,
    changes: row.changes_json ? JSON.parse(row.changes_json) : null,
    createdAt: row.created_at,
  };
}

export class SecurityInboxRepository {
  constructor(private readonly database: SqliteDatabase) {}

  close(): void {
    this.database.close();
  }

  immediate<T>(operation: () => T): T {
    return this.database.transaction(operation).immediate();
  }

  hasProject(projectId: string): boolean {
    return this.database.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId) !== undefined;
  }

  insertProject(project: Project): void {
    this.database.prepare(`
      INSERT INTO projects (
        id, name, description, repository_reference, directory_path, owner_id, created_at, updated_at
      ) VALUES (
        @id, @name, @description, @repositoryReference, @directoryPath, @ownerId, @createdAt, @updatedAt
      )
    `).run(project);
  }

  findProjectByDirectoryPath(directoryPath: string): Project | undefined {
    const row = this.database.prepare(
      'SELECT * FROM projects WHERE directory_path = ?',
    ).get(directoryPath) as ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  listProjects(input: ListProjectsInput = {}): ProjectSummary[] {
    const ownerId = input.scope === 'mine' ? input.ownerId ?? null : null;
    const rows = this.database.prepare(`
      SELECT
        p.*,
        u.slug AS owner_slug,
        u.name AS owner_name,
        u.color AS owner_color,
        u.created_at AS owner_created_at,
        SUM(CASE WHEN f.status IN ('pending_review', 'confirmed', 'in_progress') AND f.severity = 'critical' THEN 1 ELSE 0 END) AS critical_count,
        SUM(CASE WHEN f.status IN ('pending_review', 'confirmed', 'in_progress') AND f.severity = 'high' THEN 1 ELSE 0 END) AS high_count,
        SUM(CASE WHEN f.status IN ('pending_review', 'confirmed', 'in_progress') AND f.severity = 'medium' THEN 1 ELSE 0 END) AS medium_count,
        SUM(CASE WHEN f.status IN ('pending_review', 'confirmed', 'in_progress') AND f.severity = 'low' THEN 1 ELSE 0 END) AS low_count,
        SUM(CASE WHEN f.status IN ('pending_review', 'confirmed', 'in_progress') AND f.severity = 'informational' THEN 1 ELSE 0 END) AS informational_count,
        SUM(CASE WHEN f.status IN ('pending_review', 'confirmed', 'in_progress') THEN 1 ELSE 0 END) AS open_total,
        SUM(CASE WHEN f.status = 'pending_review' THEN 1 ELSE 0 END) AS pending_review_count
      FROM projects p
      JOIN users u ON u.id = p.owner_id
      LEFT JOIN findings f ON f.project_id = p.id
      WHERE @ownerId IS NULL OR p.owner_id = @ownerId
      GROUP BY p.id
      ORDER BY p.name COLLATE NOCASE, p.id
    `).all({ ownerId }) as ProjectSummaryRow[];

    return rows.map((row) => {
      const openCounts: SeverityCounts = {
        critical: row.critical_count,
        high: row.high_count,
        medium: row.medium_count,
        low: row.low_count,
        informational: row.informational_count,
      };
      return {
        ...toProject(row),
        owner: toUser({
          id: row.owner_id,
          slug: row.owner_slug,
          name: row.owner_name,
          color: row.owner_color,
          created_at: row.owner_created_at,
        }),
        openCounts,
        openTotal: row.open_total,
        pendingReviewCount: row.pending_review_count,
        worstOpenSeverity: worstOpenSeverity(openCounts),
      };
    });
  }

  insertUser(user: User): void {
    this.database.prepare(`
      INSERT INTO users (id, slug, name, color, created_at)
      VALUES (@id, @slug, @name, @color, @createdAt)
    `).run(user);
  }

  findUserBySlug(slug: string): User | undefined {
    const row = this.database.prepare('SELECT * FROM users WHERE slug = ?').get(slug) as UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  findUserById(id: string): User | undefined {
    const row = this.database.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  listUsers(): User[] {
    const rows = this.database.prepare(
      'SELECT * FROM users ORDER BY name COLLATE NOCASE, slug',
    ).all() as UserRow[];
    return rows.map(toUser);
  }

  countUsers(): number {
    const row = this.database.prepare('SELECT count(*) AS total FROM users').get() as { total: number };
    return row.total;
  }

  findIdempotent(projectId: string, idempotencyKey: string): Pick<
    StoredFinding,
    'id' | 'requestFingerprint'
  > | undefined {
    const row = this.database.prepare(`
      SELECT id, request_fingerprint
      FROM findings
      WHERE project_id = ? AND idempotency_key = ?
    `).get(projectId, idempotencyKey) as Pick<FindingRow, 'id' | 'request_fingerprint'> | undefined;
    return row ? { id: row.id, requestFingerprint: row.request_fingerprint } : undefined;
  }

  insertFinding(finding: StoredFinding): void {
    this.database.prepare(`
      INSERT INTO findings (
        id, project_id, idempotency_key, request_fingerprint, title, normalized_title,
        description, severity, status, file_path, line_number, commit_ref, evidence,
        recommendation, origin, created_at, updated_at
      ) VALUES (
        @id, @projectId, @idempotencyKey, @requestFingerprint, @title, @normalizedTitle,
        @description, @severity, @status, @filePath, @lineNumber, @commitRef, @evidence,
        @recommendation, @origin, @createdAt, @updatedAt
      )
    `).run(finding);
  }

  getFinding(projectId: string, findingId: string): FindingDetail | undefined {
    const row = this.database.prepare(`
      SELECT * FROM findings WHERE project_id = ? AND id = ?
    `).get(projectId, findingId) as FindingRow | undefined;
    if (!row) return undefined;

    const history = this.database.prepare(`
      SELECT * FROM finding_events
      WHERE finding_id = ?
      ORDER BY created_at, id
    `).all(findingId) as EventRow[];
    return { ...toFinding(row), history: history.map(toEvent) };
  }

  listFindings(input: ListFindingsInput): FindingSummary[] {
    const rows = this.database.prepare(`
      SELECT * FROM findings
      WHERE project_id = @projectId
        AND (@severity IS NULL OR severity = @severity)
        AND (@status IS NULL OR status = @status)
        AND (
          @query IS NULL
          OR instr(lower(title), lower(@query)) > 0
          OR instr(lower(description), lower(@query)) > 0
          OR instr(lower(evidence), lower(@query)) > 0
          OR instr(lower(origin), lower(@query)) > 0
        )
      ORDER BY updated_at DESC, id
      LIMIT @limit
    `).all({
      projectId: input.projectId,
      severity: input.severity ?? null,
      status: input.status ?? null,
      query: input.query ?? null,
      limit: input.limit ?? 100,
    }) as FindingRow[];

    return rows.map((row) => {
      const finding = toFinding(row);
      return {
        id: finding.id,
        projectId: finding.projectId,
        title: finding.title,
        severity: finding.severity,
        status: finding.status,
        origin: finding.origin,
        filePath: finding.filePath,
        lineNumber: finding.lineNumber,
        updatedAt: finding.updatedAt,
      };
    });
  }

  updateFinding(finding: Finding, normalizedTitle: string): void {
    this.database.prepare(`
      UPDATE findings SET
        title = @title,
        normalized_title = @normalizedTitle,
        description = @description,
        severity = @severity,
        file_path = @filePath,
        line_number = @lineNumber,
        commit_ref = @commitRef,
        evidence = @evidence,
        recommendation = @recommendation,
        origin = @origin,
        updated_at = @updatedAt
      WHERE project_id = @projectId AND id = @id
    `).run({ ...finding, normalizedTitle });
  }

  updateStatus(projectId: string, findingId: string, status: FindingStatus, updatedAt: string): void {
    this.database.prepare(`
      UPDATE findings SET status = ?, updated_at = ? WHERE project_id = ? AND id = ?
    `).run(status, updatedAt, projectId, findingId);
  }

  touchFinding(projectId: string, findingId: string, updatedAt: string): void {
    this.database.prepare(`
      UPDATE findings SET updated_at = ? WHERE project_id = ? AND id = ?
    `).run(updatedAt, projectId, findingId);
  }

  insertEvent(event: FindingEvent): void {
    this.database.prepare(`
      INSERT INTO finding_events (
        id, finding_id, kind, from_status, to_status, note, changes_json, created_at
      ) VALUES (
        @id, @findingId, @kind, @fromStatus, @toStatus, @note, @changesJson, @createdAt
      )
    `).run({
      ...event,
      changesJson: event.changes ? JSON.stringify(event.changes) : null,
    });
  }

  duplicateRows(projectId: string, excludeFindingId?: string): DuplicateRow[] {
    const rows = this.database.prepare(`
      SELECT * FROM findings
      WHERE project_id = ? AND (? IS NULL OR id != ?)
    `).all(projectId, excludeFindingId ?? null, excludeFindingId ?? null) as FindingRow[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      severity: row.severity,
      status: row.status,
      updatedAt: row.updated_at,
      normalizedTitle: row.normalized_title,
    }));
  }
}
