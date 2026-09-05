# Security Inbox — diseño funcional inicial

## Objetivo

Crear una aplicación local para una sola persona que reciba, organice y revise
sospechas de seguridad por proyecto. Registrar una sospecha no la confirma y la
aplicación no detecta ni corrige vulnerabilidades.

## Arquitectura

Un repositorio TypeScript con una capa de aplicación compartida y dos
adaptadores:

- Web Fastify con HTML renderizado en servidor y Nunjucks.
- Servidor MCP v2 por stdio mediante `@modelcontextprotocol/server`.
- SQLite mediante `better-sqlite3`, con WAL, claves foráneas y transacciones.

La web y MCP construyen el mismo `SecurityInboxService`; no comparten código de
transporte. El host remoto ejecutará Node 24 dentro de Docker porque su Node del
sistema es 18 y está fuera del baseline.

## Contrato de dominio

- `Project`: `id`, `name`, `description`, `repositoryReference`, `createdAt`,
  `updatedAt`. `id` es UUID estable y nunca editable.
- `Finding`: `id`, `projectId`, `title`, `description`, `severity`, `status`,
  `filePath`, `lineNumber`, `commitRef`, `evidence`, `recommendation`, `origin`,
  `createdAt`, `updatedAt`.
- Gravedades: `critical`, `high`, `medium`, `low`, `informational`.
- Estados: `pending_review`, `confirmed`, `in_progress`, `resolved`, `dismissed`.
- Todo hallazgo nace en `pending_review`.
- `updateFinding` solo edita título, descripción, gravedad, ubicación, evidencia,
  recomendación y origen; nunca proyecto, estado, claves ni fechas.
- `updateFindingStatus` recibe estado nuevo y nota opcional. Resolver o descartar
  exige una nota no vacía en esa misma llamada. Estado, nota, evento y
  `updatedAt` cambian en una única transacción; una nota anterior no satisface
  el requisito. Un no-op de estado devuelve `NO_STATUS_CHANGE`.
- `addFindingNote` añade una nota sin cambiar estado. Ediciones, notas y
  transiciones generan eventos append-only y actualizan `updatedAt`.
- `registerFinding` exige clave de idempotencia por proyecto. La restricción
  única evita duplicados y un fingerprint detecta reutilización con otro payload.
  Dos conexiones se serializan con `BEGIN IMMEDIATE`: el retry idéntico devuelve
  el mismo hallazgo con `created: false`; otro payload devuelve
  `IDEMPOTENCY_CONFLICT` sin mutar datos.
- La detección de parecidos compara títulos normalizados dentro del mismo
  proyecto y solo devuelve hasta cinco candidatos; nunca fusiona ni confirma.
  `listFindings` acepta `query` para comprobar antes de registrar y
  `registerFinding` devuelve también candidatos, excluyendo el propio hallazgo.

### Firmas compartidas

```ts
type Severity = 'critical' | 'high' | 'medium' | 'low' | 'informational';
type FindingStatus =
  | 'pending_review'
  | 'confirmed'
  | 'in_progress'
  | 'resolved'
  | 'dismissed';
type FindingEventKind = 'created' | 'edited' | 'status_changed' | 'note';

type Scalar = string | number | null;
type FieldChange = { from: Scalar; to: Scalar };

type Project = {
  id: string;
  name: string;
  description: string;
  repositoryReference: string | null;
  createdAt: string;
  updatedAt: string;
};
type SeverityCounts = Record<Severity, number>;
type ProjectSummary = Project & {
  openCounts: SeverityCounts;
  openTotal: number;
  pendingReviewCount: number;
};
type CreateProjectInput = {
  name: string;
  description: string;
  repositoryReference?: string | null;
};

type Finding = {
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
type FindingSummary = Pick<
  Finding,
  | 'id' | 'projectId' | 'title' | 'severity' | 'status' | 'origin'
  | 'filePath' | 'lineNumber' | 'updatedAt'
>;
type FindingEvent = {
  id: string;
  findingId: string;
  kind: FindingEventKind;
  fromStatus: FindingStatus | null;
  toStatus: FindingStatus | null;
  note: string | null;
  changes: Record<string, FieldChange> | null;
  createdAt: string;
};
type FindingDetail = Finding & { history: FindingEvent[] };
type FindingIdentity = { projectId: string; findingId: string };

type RegisterFindingInput = {
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
type EditableFindingFields = {
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
type ListFindingsInput = {
  projectId: string;
  severity?: Severity;
  status?: FindingStatus;
  query?: string;
  limit?: number;
};
type DuplicateCandidate = Pick<
  Finding,
  'id' | 'projectId' | 'title' | 'severity' | 'status' | 'updatedAt'
> & { match: 'exact' | 'similar'; score: number };
type RegisterFindingResult = {
  finding: FindingDetail;
  created: boolean;
  possibleDuplicates: DuplicateCandidate[];
};

type AppErrorCode =
  | 'VALIDATION_ERROR'
  | 'PROJECT_NOT_FOUND'
  | 'FINDING_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'TERMINAL_NOTE_REQUIRED'
  | 'NO_STATUS_CHANGE';
type PublicAppError = {
  code: AppErrorCode;
  message: string;
  fieldErrors?: Record<string, string[]>;
};

createProject(input: CreateProjectInput): Project
listProjects(): ProjectSummary[]
registerFinding(input: RegisterFindingInput): RegisterFindingResult
listFindings(input: ListFindingsInput): FindingSummary[]
getFinding(input: FindingIdentity): FindingDetail
updateFinding(input: FindingIdentity & EditableFindingFields): FindingDetail
updateFindingStatus(input: FindingIdentity & { status: FindingStatus; note?: string }): FindingDetail
addFindingNote(input: FindingIdentity & { note: string }): FindingDetail
findPossibleDuplicates(input: { projectId: string; title: string; excludeFindingId?: string }): DuplicateCandidate[]
```

Toda operación de hallazgo recibe `projectId` y `findingId`; una combinación
cruzada devuelve `FINDING_NOT_FOUND`. Los errores públicos son
`VALIDATION_ERROR`, `PROJECT_NOT_FOUND`, `FINDING_NOT_FOUND`,
`IDEMPOTENCY_CONFLICT`, `TERMINAL_NOTE_REQUIRED` y `NO_STATUS_CHANGE`.
El servicio lanza `AppError` con `code` y `PublicAppError`; web traduce códigos a
HTTP 400/404/409 y MCP a `isError: true`, conservando el código pero usando un
mensaje genérico y sin eco del input.

Los listados de proyectos ordenan por nombre; los de hallazgos por `updatedAt`
descendente. El historial se entrega cronológicamente por `createdAt` e `id`.
Los candidatos exactos preceden a los similares; después se ordenan por score y
actualización. La similitud usa Jaccard sobre tokens únicos normalizados, exige
dos tokens compartidos y score `>= 0.6`; un título de una palabra solo coincide
exactamente. `EditableFindingFields` debe contener al menos un campo editable y
`note` solo documenta esa edición; no puede crear por sí sola un evento de nota.

### Validación

- Nombre de proyecto 1–120; descripción 1–2.000; referencia opcional 1–500.
- Título 1–200; descripción y evidencia 1–10.000; origen 1–200.
- Recomendación opcional 1–5.000; archivo opcional 1–1.000; commit opcional
  1–200; línea entera 1–10.000.000 y solo válida con archivo.
- Nota 1–5.000; idempotency key 1–200; búsqueda 1–200; todos tras `trim`.
- IDs deben ser UUID. Los filtros aceptan una gravedad y un estado válidos,
  ordenan por actualización descendente y limitan a 100 filas.

## Persistencia

Tablas `projects`, `findings` y `finding_events`. `findings` conserva
`idempotency_key`, `request_fingerprint` y `normalized_title`, con
`UNIQUE(project_id, idempotency_key)`. `finding_events` conserva `kind`,
`from_status`, `to_status`, `note`, `changes_json` y fecha. Índices cubren
proyecto/estado/gravedad y eventos por hallazgo. Zod valida antes de SQLite y
`CHECK`, `FOREIGN KEY` y `UNIQUE` repiten las invariantes. La ruta se configura
con `SECURITY_INBOX_DB` y por defecto es `data/security-inbox.sqlite`.

El fingerprint es SHA-256 de JSON en orden fijo con todos los campos validados,
valores recortados y opcionales representados como `null`; incluye `projectId`
y excluye la clave idempotente. La prueba concurrente abre dos conexiones a la
misma base y exige un solo registro.

## Web

Páginas para proyectos, listado filtrable, alta manual, detalle, edición,
cambio de estado y notas. Cada proyecto muestra recuentos por gravedad de todos
los estados no terminales (`pending_review`, `confirmed`, `in_progress`) y un
recuento separado “sin revisar”. El formulario de alta incluye una acción
explícita para comprobar candidatos parecidos antes de crear. La interfaz usa
una estética de cuaderno de incidentes, responsive y sin JavaScript cliente.

En ejecución nativa escucha en `127.0.0.1`. En Compose escucha en `0.0.0.0`
dentro del bridge propio del proyecto y Docker publica exclusivamente
`127.0.0.1:3300:3300` en el host. La red no se marca `internal`, porque Docker
no publica puertos desde una red sin conexión a las interfaces del host. MCP no
declara ningún puerto. Ningún otro bind es válido.

Las mutaciones solo aceptan `Host` `127.0.0.1:3300`, `localhost:3300` o
`[::1]:3300`; `Origin` es obligatorio e igual a `http://${Host}`; un
`Sec-Fetch-Site: cross-site` se rechaza. Un token aleatorio por proceso se
incluye como campo oculto y se compara en tiempo constante. GET entrega el token
y POST legítimo se prueba además de los rechazos. Se escapa todo texto no
confiable y se envía CSP restrictiva.

## MCP

Dependencias exactas: `@modelcontextprotocol/server@2.0.0` y
`@modelcontextprotocol/client@2.0.0`; imports stdio desde sus subpaths `/stdio`.
Herramientas: `list_projects`, `register_finding`, `list_findings`,
`get_finding`, `update_finding_status` y `add_finding_note`. stdout queda
reservado al protocolo incluso ante error; no se registran payloads, notas ni
claves idempotentes. Una prueba E2E usa el cliente oficial para arrancar el
proceso stdio, listar herramientas y recorrer éxito y error.

## Demo y aceptación

Un seed idempotente aporta dos proyectos y seis hallazgos que cubren las cinco
gravedades y al menos cuatro estados. La prueba cierra y reabre el archivo
SQLite antes de comprobar IDs y filas. Docker Compose
monta `./data` para demostrar persistencia y publica la web solo en loopback. El
README enlaza una guía MCP/skill con configuración genérica, instalación de la
skill, túnel SSH y límites verificados, sin afirmar compatibilidad con hosts no
probados. La ruta vigente, que sustituye el destino inicial, es
`arturo-dev:/root/Proyectos/security-inbox`; Penthos queda expresamente fuera de
toda lectura y escritura.
