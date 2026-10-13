# Plan de mantenimiento y seguridad para el entorno local

Fecha: 2026-10-13

Estado: en ejecución; ver [Estado de ejecución](#estado-de-ejecución)

Objetivo: conservar una bandeja fiable y recuperable, con mantenimiento sencillo y controles proporcionales al homelab.

## Contexto y decisiones

Arturo indica que el servicio vive en un entorno local y que el acceso de un tercero a su red es poco probable. Esa premisa reduce la prioridad de añadir autenticación a la web, aislamiento entre usuarios o infraestructura de seguridad adicional. Las prioridades son las actualizaciones pequeñas, los datos recuperables y la prevención de errores durante pruebas o despliegues.

Se conservan Host, Origin, CSRF, escape de plantillas, validación, contención de directorios y las protecciones existentes del MCP. Si se usa MCP por HTTP, se mantiene su comprobación de bearer token. La atribución de la web y del MCP por stdio sigue sin convertirse en autorización por propietario.

Este documento define trabajo futuro. Su creación no ejecuta cambios de código, actualizaciones del servidor, copias reales, servicios programados, commits, publicaciones o despliegues.

## Base y evidencia

- Checkout local limpio al comenzar: `main`, SHA `8b5f24e6050280f9fc23574d01a49751552139cb`.
- La auditoría anterior corresponde a ese SHA: 75 archivos, cero vulnerabilidades reportables en las rutas revisadas y 121 pruebas, typecheck y build correctos en una copia privada. Es evidencia de ese snapshot, no de la instalación central.
- `origin/main`, según las refs locales consultadas sin fetch, apunta a `4c7f731733f35ec0a1305a13f1047ae85451a59f`, siete commits después. Añade MCP HTTP opcional, API de lectura/exportación, detección de secretos y esquema v5. Esas adiciones no quedan cubiertas por el resultado de la auditoría anterior.
- Las dependencias de `package.json` no cambian entre esas dos revisiones. El lockfile local contiene los cuatro grupos de avisos descritos en el paso 2.
- La instalación documentada es `arturo-dev:/root/Proyectos/security-inbox`. Su versión y configuración efectivas no se han comprobado al preparar este plan.
- Evidencia local: `package.json:18-34`, `compose.yaml:7-23,33-55`, `src/storage/database.ts:279-295`, `scripts/verify-demo.sh:9-26` y `docs/deployment.md:41-60`.
- Evidencia de la revisión posterior: en `4c7f731`, `compose.yaml:59-66`, `docs/deployment.md:58-88`, `src/mcp/http.ts`, `src/mcp/tokens.ts`, `src/web/read-api.ts`, `src/core/secrets.ts` y sus consumidores en `src/core/service.ts`. Puede consultarse sin cambiar el checkout con `git show 4c7f731733f35ec0a1305a13f1047ae85451a59f:<ruta>`.
- [Informe anterior](/Users/arturo/.codex/state/plugins/codex-security/scans/security-inbox/8b5f24e6050280f9fc23574d01a49751552139cb_20261010T233528Z_rjov8774/report.md), conservado fuera del repositorio. El resto de este plan incluye el contexto necesario para ejecutarlo aunque ese archivo no esté disponible en otro equipo.

## Orden recomendado

| Paso | Prioridad | Resultado | Esfuerzo orientativo |
| --- | --- | --- | --- |
| 1. Identificar la versión y las interfaces usadas | Antes de cambiar nada | Base de ejecución conocida y comprobación breve de exposición local | Pequeño |
| 2. Actualizar dependencias de forma acotada | Alta de mantenimiento | Desaparecen los avisos conocidos sin cambiar los transportes | Pequeño |
| 3. Copias consistentes y restauración ensayada | Alta para los datos | Recuperación demostrada y copia previa a cada actualización | Medio |
| 4. Hacer seguros los recorridos de verificación | Media | Las demos y pruebas no pueden afectar al stack ni a los datos compartidos | Medio |
| 5. Rutina de mantenimiento breve | Media | Revisiones mensuales y cambios registrados sin actualizaciones automáticas | Pequeño |

Los pasos 2 y 4 se preparan en un checkout aislado después del paso 1. El paso 3 debe estar resuelto antes de actualizar el servicio compartido. Las operaciones de despliegue se proponen al terminar y verificar los cambios.

## 1. Identificar versión e interfaces

Responsabilidad: diagnóstico de lectura del proyecto y de sus servicios concretos. No requiere modificar el producto.

1. Registrar checkout, SHA y cambios preexistentes tanto del workspace que se vaya a usar como del repositorio central. Identificar la imagen efectiva de web y de cada modalidad MCP activa. No imprimir `.env`, cabeceras Authorization ni el fichero de tokens.
2. Elegir y congelar el SHA de implementación. Comparar los cambios posteriores al auditado antes de usar sus conclusiones. Si el código instalado ya incluye una mejora del plan, verificarla y marcarla satisfecha en lugar de implementarla otra vez.
3. Comprobar solo los endpoints de Security Inbox: publicación de web en 3300, proxy privado documentado y, si se usa, MCP HTTP en 3301. Confirmar con configuración y listeners del servicio que los binds coinciden con el uso local previsto. Una IP local no demuestra por sí sola la ausencia de publicación externa; basta una revisión acotada de las reglas que publican este servicio, sin escaneo de toda la red.
4. Mantener MCP HTTP como modalidad opcional. Si no se necesita, no activarlo en el despliegue propuesto. Si ya se usa, conservar bearer token y las restricciones de Origin, con su fichero fuera de Git y permisos de lectura solo para los principales necesarios. Comprobar permisos y funcionamiento sin mostrar valores de tokens.
5. Confirmar la compatibilidad de esquema. La versión auditada admite hasta v4; la revisión `4c7f731` introduce v5. No abrir la base compartida con el checkout antiguo si ya está en v5. Al actualizar, todos los procesos que la abren deben usar una imagen compatible; revertir únicamente la imagen puede ser insuficiente después de una migración.

Aprobación del paso: SHA, imagen, esquema y endpoints usados quedan registrados sin secretos. No queda una discrepancia desconocida entre el código preparado y el código que abre la base.

## 2. Actualizar las dependencias afectadas

Responsabilidad: `package.json` y `package-lock.json`. Mantener Node 24, npm, versiones fijadas y los transportes que realmente se usan. Los tests correspondientes solo cambian si una modificación de contrato está justificada.

| Dependencia | Versión en el lockfile auditado | Mínimo corregido que sirve de referencia |
| --- | --- | --- |
| `@modelcontextprotocol/client` | 2.0.0 | [2.2.0](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h) |
| `fastify` | 5.12.3 | [5.12.5](https://github.com/fastify/fastify/security/advisories/GHSA-4mh8-r7rc-xpvc) |
| `fast-uri` | 3.1.7 y 4.1.4, transitivas | [3.1.8 y 4.1.5 en sus respectivas ramas](https://github.com/fastify/fast-uri/security/advisories/GHSA-hrr3-gc8f-f4qj) |
| `source-map-js` | 1.2.1, de desarrollo | [1.2.2](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2) |

Son mínimos asociados a los avisos conocidos, no una orden de fijar ciegamente esas versiones. En la ejecución se comprobarán los avisos vigentes y se elegirá una versión corregida compatible dentro de las ramas actuales.

1. Preparar el checkout aislado con el lockfile existente y `npm ci`, usando Node 24. Establecer el baseline del SHA elegido en una raíz de pruebas privada con datos sintéticos.
2. Actualizar los paquetes directos y las resoluciones transitivas afectadas. Mantener coherentes las dependencias y peers del SDK MCP. Evitar una actualización general de todas las herramientas o `npm audit fix --force`.
3. Revisar el diff completo del lockfile y cualquier cambio adicional necesario. No introducir OAuth, HTTP/2, un nuevo proveedor o un transporte nuevo para resolver estos avisos.
4. Ejecutar `npm audit --package-lock-only --ignore-scripts`, `npm test`, `npm run typecheck` y `npm run build` dentro del entorno aislado. En la versión posterior, incluir sus pruebas de MCP HTTP, API de lectura y secretos, además del recorrido stdio.
5. Si el SDK negocia una revisión MCP diferente, comprobar y documentar la compatibilidad real. No cambiar expectativas de tests únicamente para ocultar un fallo.

Aprobación del paso: los cuatro grupos de avisos conocidos dejan de aparecer, no quedan versiones afectadas duplicadas en el lockfile, los nuevos avisos se triajan por su ruta de uso y todas las verificaciones pasan sobre el mismo SHA y lockfile. Los 121 tests del informe antiguo no sustituyen a la suite de la base elegida.

## 3. Copias recuperables de SQLite

Responsabilidad: procedimiento y script de backup del proyecto, sus pruebas sintéticas y `docs/deployment.md`. El destino y el programador del host se concretan antes de activar la rutina.

1. Usar una copia consistente mediante `sqlite3.backup` de Python o `.backup` de SQLite, como ya indica `docs/deployment.md:41-44`. La base usa WAL; copiar solamente el archivo principal mientras está activa no es el procedimiento de backup.
2. Propuesta inicial para el homelab: una copia diaria, siete versiones diarias y una copia identificada previa a cada actualización o migración. Acordar el destino antes de activarlo; aprovechar otro disco o equipo existente para una segunda copia si está disponible.
3. Crear los archivos con permisos privados y un nombre que incluya fecha y versión de aplicación/esquema. Publicar una copia como válida solo cuando termine correctamente. Conservar la copia previa a una actualización mientras siga siendo necesaria para recuperar esa versión.
4. Ensayar primero con fixtures sintéticas que tengan proyectos, hallazgos e historial. Restaurar en una ruta temporal independiente y comprobar `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, versión de esquema y conservación de identidades e historial. La salida solo informa de resultados y conteos.
5. Para el primer ensayo de una copia real, usar otro archivo y un servicio aislado con versión compatible. No sustituir la base compartida. No adjuntar la base ni sus contenidos al repositorio o a informes de agentes.
6. Un fallo de backup debe quedar visible en la herramienta de operación ya disponible. La retención solo puede limpiar copias de esta rutina cuya creación y estado se conocen; no se elimina la única copia recuperable.

Aprobación del paso: se ha demostrado restauración en aislamiento, está identificada la última copia válida y el procedimiento explica la recuperación tras una migración. La programación real, cambios de permisos y eliminación por retención requieren la autorización correspondiente sobre el host; este plan no los activa.

## 4. Verificación que preserve el servicio compartido

Responsabilidad: `scripts/verify-demo.sh`, configuración de Compose exclusiva para pruebas si hace falta y documentación del recorrido. Mantener el contrato de runtime y los controles existentes.

El script actual crea `./data`, ejecuta seed/demo y hace `docker compose down --remove-orphans` sobre el proyecto activo (`scripts/verify-demo.sh:9-26`). La documentación prohíbe usar seed/demo en la bandeja central. La mejora busca prevenir una ejecución accidental sobre recursos compartidos.

1. Convertir el recorrido de demo en una ejecución con raíz privada, base sintética, carpetas sintéticas, nombre de proyecto Compose exclusivo y puerto loopback distinto del servicio real.
2. Pasar explícitamente rutas y configuración a todos los procesos y contenedores hijos. Resolver colisiones de puerto como un fallo de preparación, sin parar otro servicio ni usar la base real como alternativa.
3. Limpiar únicamente los recursos exactos creados por ese recorrido, tras confirmar el cierre de sus procesos. Ante fallo o cierre incierto, conservar los logs y los recursos necesarios para diagnosticarlo.
4. En un entorno desechable, usar un stack sintético de referencia para comprobar que el recorrido no modifica su base ni lo detiene. Verificar también que una salida por error conserva evidencia y no ejecuta una limpieza sobre el proyecto de referencia.
5. Conservar las pruebas existentes de Host/Origin/CSRF, SQL, symlinks e historial. En la revisión posterior, verificar con fixtures los rechazos de secretos y el acceso sin token al MCP HTTP; no crear otro detector ni relajar el actual para hacer pasar una prueba.

Aprobación del paso: demo y reintento funcionan sobre sus propios recursos; el stack sintético de referencia mantiene estado y datos; los fallos dejan evidencia útil; ninguna prueba necesita datos reales. El confinamiento exigido por las instrucciones del proyecto debe estar disponible antes de ejecutar el recorrido.

## 5. Mantenimiento proporcionado

Responsabilidad: una rutina breve en `docs/deployment.md` y estado de ejecución en este documento, enlazado desde `tasks/todo.md`.

- Una vez al mes: revisar avisos del lockfile y antigüedad de la última copia válida. Las actualizaciones se preparan en un lote pequeño, con los mismos gates del paso 2; no se instalan automáticamente sobre el servicio.
- Antes de una actualización: copia consistente, versión y esquema compatibles, checks del snapshot final y revisión del diff. Al desplegar una versión compatible, verificar web y las modalidades MCP usadas y renovar los procesos clientes que necesiten la nueva imagen.
- Tras cambiar VPN, router, proxy o bind: repetir solo la comprobación de exposición de Security Inbox del paso 1.
- Ensayar restauración al poner en marcha los backups y después de modificar el procedimiento o de una migración. Una comprobación trimestral es una propuesta razonable si no hay otros cambios.
- Mantener la observación CSS `2858e8e4-5087-4a48-a108-6f55fda894ef` como mantenimiento menor en Security Inbox. La variable cíclica existe en el snapshot auditado, pero no hay impacto visual actual demostrado; no bloquea las mejoras prioritarias.

No se programa ninguna automatización como parte de la creación de este plan.

## Trabajo que puede esperar

La autenticación adicional de la web, el aislamiento por propietario, WAF, SIEM, escaneos de red recurrentes, refactors de seguridad generales y tuning de cuotas quedan fuera de la primera fase. Se reconsiderarán si aparece una exposición más amplia, usuarios no confiables, datos que requieran otro nivel de protección o problemas de carga medidos. Las protecciones ya implementadas se conservan.

Tampoco se priorizan una reconstrucción de la imagen en múltiples etapas, migraciones de framework o cambios de modelo/proveedor. Resolver los avisos y poder recuperar los datos aporta más valor inmediato en este contexto.

## Límites y cierre de ejecución

- Usar únicamente los paths de cada paso y preservar cambios preexistentes. No leer ni modificar Penthos ni otros servicios del homelab.
- Mantener fuera de Git `.env`, `data`, tokens, copias reales y valores de credenciales. Las pruebas usan fixtures sintéticas y raíces privadas explícitas.
- Detener la acción afectada si la base o imagen efectiva difiere de la prevista, el esquema no es compatible, no existe aislamiento fiable o falta acceso imprescindible.
- La ejecución de código autorizada sigue el flujo Git del proyecto: checkout aislado, comprobaciones y diff staged de cambios propios. Commit/push requieren aprobación explícita del diff; merge exige además CI y revisión independiente sobre el snapshot final.
- Despliegue, modificación del host, programación de backups y recuperación sobre datos reales son pasos posteriores con autorización específica. Presentar primero el cambio verificable, el resultado de sus checks y el procedimiento de recuperación.
- El cierre del plan registra por paso: satisfecho por una versión existente, implementado y verificado, o pendiente con un motivo concreto. Un check local correcto no acredita por sí solo la operación central.

## Criterio final

El servicio sigue siendo sencillo para su uso local: versión e interfaces conocidas, dependencias mantenidas, datos recuperables, pruebas que conservan recursos compartidos y un procedimiento breve para repetir estas comprobaciones.

## Estado de ejecución

Registro canónico del trabajo; `tasks/todo.md` enlaza aquí. El original de este plan
sigue staged, sin cambios, en el checkout principal (`main`, `8b5f24e`); esta copia
vive en el worktree de la rama y es la que lleva el estado.

| Dato | Valor |
| --- | --- |
| Issue | [#6](https://github.com/theBrokenCat/security-inbox/issues/6) |
| Responsable | Claude Code (lead, `app-direct`) |
| Worktree | `/Users/arturo/Proyectos/security-inbox.worktrees/feat-6-local-maintenance`, rama `feat/6-local-maintenance` sin upstream |
| SHA base congelado | `4c7f731733f35ec0a1305a13f1047ae85451a59f` (`origin/main` tras `fetch --prune`, 2026-10-13) |
| Evidencia local | `/Users/arturo/Proyectos/security-inbox.worktrees/feat-6-evidence` (fuera de Git, `0700`) |
| Estado | Pasos 1–5 implementados y verificados; revisión independiente `pass` (ronda 2, árbol `0c44277`) |
| Pendiente | Aprobación del diff; commit/push/PR; merge (sin CI en el repositorio); despliegue, activación de copias y ensayo con copia real en arturo-dev; decisión sobre segunda copia fuera del disco |
| Siguiente acción | Esperar las aprobaciones solicitadas al usuario; nada se ha operado en arturo-dev |

Leyenda: **existente** (mejora ya presente y verificada), **implementado** (cambio
verificado en el worktree), **operación** (instalado y comprobado en arturo-dev),
**pendiente** (bloqueo concreto).

### Paso 1 — versión e interfaces (2026-10-13, solo lectura)

- Checkout central `arturo-dev:/root/Proyectos/security-inbox`: `4c7f731`, sin cambios
  en archivos versionados; ignorados `.env`, `backups/`, `data/`, `dist/`.
- Imagen `security-inbox:local` = `sha256:878d609f…`, creada 2026-10-04 18:34:51Z.
  Contiene el código de `0c72131` (marcadores `maxConnections` y `glpat` presentes;
  ausentes en `8a7c28a`); `0c72131..4c7f731` solo cambia `README.md`. Node 24.20.0,
  fastify 5.12.3, `@modelcontextprotocol/client` 2.0.0.
- Procesos que abren la base: web `security-inbox-web-1` y 15 sesiones MCP stdio
  (`security-inbox-mcp-run-*`), las 16 sobre `878d609f`. Sin `mcp-http`, sin
  `data/mcp-tokens`: **MCP HTTP no se usa**.
- Esquema: `user_version = 5`, WAL, SQLite 3.53.4; 3 usuarios, 10 proyectos,
  164 hallazgos, 337 eventos (solo conteos).
- **Existente:** el código rechaza esquemas más nuevos (`database.ts`: `expected at
  most N`); `8b5f24e` admite como máximo v4, así que un proceso antiguo falla al abrir
  v5 en lugar de escribir. Mi cambio no modifica el esquema.
- `.env`: solo `SECURITY_INBOX_USER`, `SECURITY_INBOX_DEFAULT_USER`,
  `SECURITY_INBOX_WEB_ORIGIN=http://192.168.0.130:3300`, `SECURITY_INBOX_WEB_BIND=127.0.0.1`
  y `COMPOSE_FILE=compose.yaml:compose.remote.yaml`; ninguna credencial.
- Exposición (revisión acotada a 3300/3301):
  - web publica `127.0.0.1:3300` (docker-proxy), como prevé el despliegue;
  - `security-inbox-private-proxy` publica `192.168.0.130:3300` (LAN) y `127.0.0.1:3301`,
    ambos hacia su `:8080`;
  - `tailscale serve` publica `https://arturo-dev.<tailnet>.ts.net:3300` **solo tailnet**
    hacia `127.0.0.1:3301`; `tailscale funnel status` no lo expone a internet;
  - reglas DNAT de Docker solo para esos binds; `PREROUTING` descarta tráfico a
    `127.0.0.1:3300/3301` que no venga de `lo`.
  Coincide con uso LAN + VPN (tailnet). No se revisó el router: queda fuera de este host.
- Trampa operativa: `127.0.0.1:3301` ya lo ocupa el proxy. Activar `mcp-http` con su bind
  por defecto colisionaría; documentado en `docs/deployment.md`.

### Paso 2 — dependencias

Avisos vigentes en el lockfile de `4c7f731` (`npm audit --package-lock-only`):
GHSA-6qxp (client `<2.2.0`), GHSA-4mh8 (fastify `<5.12.5`), GHSA-hrr3 (fast-uri `<3.1.8`
y `<4.1.5`), GHSA-jvvf (fast-uri `>=4.1.3 <4.1.5`, nuevo desde el plan) y GHSA-68fv
(source-map-js `<1.2.2`). Además fastify publicó hoy GHSA-389g (bajo, `>=5.12.2 <5.12.6`;
no aplica: no usamos `propertyNames` en esquemas de cabeceras).

| Paquete | Antes | Después | Motivo |
| --- | --- | --- | --- |
| `@modelcontextprotocol/client`, `server` (y `core`) | 2.0.0 | 2.3.1 | Corrige GHSA-6qxp; las tres en la misma versión, sin peers |
| `fastify` | 5.12.3 | 5.12.6 | Corrige GHSA-4mh8 y GHSA-389g, misma rama 5.12 |
| `fast-uri` (bajo `ajv`) | 3.1.7 | 3.1.8 | Rama 3 |
| `fast-uri` | 4.1.4 | 4.2.2 | Máximo del rango `^4` de sus dependientes; 4.2.x solo trae correcciones |
| `source-map-js` (dev) | 1.2.1 | 1.2.2 | Rama 1.2 |

- Método: `npm install --save-exact` para las directas y `npm update fast-uri source-map-js`;
  sin `audit fix --force`. El diff del lockfile solo cambia esos 7 paquetes.
- Compatibilidad MCP: 2.3.0 exige un servidor por petición; `src/mcp/http.ts` ya lo crea en
  la factoría de `createMcpHandler`. El protocolo negociado sigue siendo `2026-07-28` y el
  test de cliente `2025-11-25` sigue pasando.
- Verificado (Node 24.3.0, TMPDIR privado y canónico): `npm audit` → 0 vulnerabilidades;
  `npm audit signatures` → 118 firmas verificadas; `npm test` 195/195 (incluye MCP stdio,
  MCP HTTP sin token, API de lectura y rechazo de secretos); typecheck y build correctos.
- Baseline de `4c7f731` en copia privada: 195/195, typecheck y build. Con TMPDIR no
  canónico (`/var/folders` → `/private/var`) fallan 3 tests de rutas: problema de entorno
  de los tests en macOS, ajeno a este plan; registrado en Security Inbox.

### Paso 3 — copias y recuperación (implementado; operación pendiente)

- `src/storage/backup.ts` + `backup-cli.ts`: API de backup de SQLite (`better-sqlite3`
  `backup()`) desde una conexión de solo lectura que nunca migra; copia temporal →
  `integrity_check` + `foreign_key_check` → modo `DELETE`, `0600` → publicación con
  `link()` (no sobrescribe) → manifiesto `.json` con SHA-256 y conteos, publicado el último.
  Retención `daily` de 7 copias válidas; no toca `pre-update`, copias manuales, archivos
  sin manifiesto ni copias alteradas. `restore` solo a una ruta nueva, comprueba manifiesto,
  integridad, claves foráneas y rechaza esquemas más nuevos que la imagen.
- `scripts/backup.sh daily|pre-update|status`: contenedor sin red, raíz de solo lectura,
  solo `data` y el destino montados; `ops/systemd/security-inbox-backup.{service,timer}`
  diario a las 03:40 (+≤20 min), `Persistent=true`; fallo visible en `systemctl --failed`
  y `journalctl`; `status` sale con 1 sin copia válida de <36 h.
- Destino propuesto: `/root/Proyectos/security-inbox/backups/sqlite` (`0700`, UID 1000),
  fuera de los montajes de web/MCP, de Git (`.gitignore`) y del contexto Docker
  (`.dockerignore`). Mismo disco que la base (único volumen del LXC): segunda copia en
  otro equipo pendiente de decisión.
- La imagen lleva `org.opencontainers.image.revision` y `SECURITY_INBOX_APP_VERSION`
  (`SECURITY_INBOX_REVISION` al construir) para nombrar copias y reconocer la imagen.
- Verificado: 16 tests (`test/storage/backup.test.ts`) — copia de filas que solo están en
  el WAL (la copia del archivo principal no las contiene), nombre/permisos/manifiesto,
  esquema antiguo sin migrar, fallos sin publicar nada, retención exacta, copia alterada
  inválida y conservada, restauración con identidades e historial, no sobrescritura,
  manifiesto alterado, esquema futuro, archivo dañado y CLI sin contenido de la bandeja.
- Ensayo de extremo a extremo (Docker local, stack sintético en marcha con la imagen base):
  `backup.sh pre-update` con la candidata y versión `4c7f731`, `daily`, `status`;
  restauración en raíz privada y web aislada en `127.0.0.1:3391` → HTTP 200, 2 proyectos
  por API y digest de filas idéntico al de la base viva; recursos del ensayo eliminados.
  Guardas: destino inexistente → 1; orden desconocida → 2.

### Paso 4 — verificación aislada (implementado)

- `compose.yaml` admite `SECURITY_INBOX_IMAGE`, `SECURITY_INBOX_DATA_DIR` y
  `SECURITY_INBOX_WEB_PORT` con los valores actuales por defecto (sin cambio para
  arturo-dev) y pasa `SECURITY_INBOX_REVISION` al build.
- `scripts/verify-demo.sh`: raíz privada `0700` con datos y carpetas sintéticos, proyecto
  `security-inbox-verify-<id>`, imagen `security-inbox:verify-<id>`, puerto
  `127.0.0.1:3390` por defecto; todas las llamadas Compose fijan proyecto, `compose.yaml` y
  un env-file vacío (ignora `COMPOSE_FILE` y `.env`). Rechaza 3300/3301, puertos ocupados
  y colisiones de proyecto/imagen. Limpia solo lo suyo y solo tras pasar; en fallo guarda
  logs, para sus contenedores y conserva raíz e imagen. Corrige además que `! grep` no
  hacía fallar el script con `set -e` y que el temporal solo se borraba bajo `/tmp`.
- RED con el script anterior sobre el stack de referencia (proyecto `security-inbox`,
  `.env` con `COMPOSE_FILE=compose.yaml:compose.remote.yaml`, red `security-inbox-private`):
  eliminó la web de referencia, reemplazó `security-inbox:local` y escribió en `./data`
  (6→7 hallazgos, 11→13 eventos); dejó su temporal en macOS.
- GREEN con el nuevo desde el mismo checkout: 214/214 en el contenedor, demo y MCP
  correctos; contenedor, arranque, salud, imagen y digest de la referencia idénticos; sin
  restos. Puerto 3300/3301 u ocupado → sale con 1 sin crear nada. SIGTERM con la web
  privada arriba → 143, raíz con `compose.log`/`ps.txt`/base, contenedor parado, imagen
  conservada y referencia intacta; después se limpiaron esos recursos por nombre exacto.

### Paso 5 — mantenimiento (documentado)

- `docs/deployment.md`: actualización con candidata y copia `pre-update` previa al cambio
  de etiqueta, vuelta atrás, copias, activación, recuperación (ensayo y real), recorrido
  aislado, revisión mensual y comprobación acotada de exposición. `AGENTS.md` resume los
  comandos duraderos.
- Observación CSS `2858e8e4-5087-4a48-a108-6f55fda894ef`: sigue diferida en Security Inbox.

### Revisión independiente

- Ronda 1 (`quality-reviewer-frontier`, árbol `9e4e59e`): `changes-requested`, 0 Blocking,
  1 Important, 8 Minor. Important: el bloque de actualización no podía hacer la copia
  `pre-update` la primera vez (sin directorio ni herramienta en la imagen en servicio) y no
  se detenía si la copia fallaba. Corregido: subshell con `set -e`, `test "$new" != "$old"`
  y secuencia de primera vez con la candidata.
- Minor aplicados: temporales únicos y limpieza del manifiesto temporal; `status` cuenta
  `.partial` y juzga la frescura por copias diarias; un manifiesto con fecha inválida se
  ignora en lugar de bloquear el directorio; `verify-demo` valida el puerto antes de buscar
  Docker y rechaza ceros iniciales (`03300`); `backup.sh` usa `unknown` si la etiqueta de
  revisión no sirve para un nombre (una versión explícita inválida sigue fallando);
  `HOME=/root` en la unidad; documentación de recuperación (espera, `python3` en lugar de
  `jq`, paso 4 explícito, sesión MCP intermedia, copias manuales con cabecera WAL), README
  y `AGENTS.md`; nombre de la tailnet retirado del registro (repositorio público).
- Tests añadidos (RED→GREEN): `refuses the port "03300"`, `status judges freshness by daily
  copies and reports leftover partial files`, `ignores a manifest whose date is not a date`.
  Cobertura de comportamiento ya correcto: limpieza del temporal tras fallar la
  verificación, restauración sin manifiesto y con `-wal` previo, código 2 del CLI y puertos
  `0`/`80`/`65536`/`abc`.
- Verificación del snapshot corregido: `npm test` 226/226, typecheck y build; Docker:
  candidata reconstruida, `verify-demo` 226/226 en el contenedor con la referencia
  intacta, ensayo de copia/restauración con digest idéntico, `status` con `partials: 0`,
  etiqueta `feat/6` → copia `unknown` con aviso y versión explícita inválida → 1. La ruta
  de interrupción no cambió desde su ensayo en la ronda 1.
- Ronda 2 (mismo revisor, árbol `0c44277`): `pass`, 0 Blocking, 0 Important. Presupuesto
  de dos rondas agotado; después solo cambia este registro.
- Minor diferidos (no cambian el código revisado):
  - N1: el bloque de «Actualizar» no se reanuda tras un fallo posterior al `pull` (`old`
    sale de HEAD) y el `curl` final no espera al arranque. En la operación se anotan
    `old`/`new` y se espera a la salud de la web.
  - N2: el comentario de `scripts/backup.sh` aún dice que `status` mira cualquier copia, y
    `countPartials` no cuenta `-journal`/`-wal`/`-shm` de un temporal interrumpido.
  - N3 no aplica en arturo-dev: `data/backups/before-*.sqlite` ya pertenece a UID 1000.

### Decisiones tomadas en la ejecución

- Ruling: estado en esta copia del plan y en `tasks/todo.md` del worktree, sin ledger
  aparte — AGENTS pide un único registro — si fuera incorrecto, basta mover esta sección.
- Ruling: fastify 5.12.6 en lugar del mínimo 5.12.5 — corrige también GHSA-389g y evita que
  la revisión mensual lo marque enseguida; publicado hoy, cubierto por la suite — si falla,
  5.12.5 es la alternativa mínima.
- Ruling: MCP SDK 2.3.1 en lugar del mínimo 2.2.0 — último parche 2.x, mismo contrato de
  servidor por petición que ya usamos — coste si falla: volver a 2.2.0.
- Ruling: sin commits hasta aprobar el diff — AGENTS prevalece sobre los pasos de commit
  de la skill — los cambios quedan staged en el worktree.
- Ruling: copias con `backup()` de better-sqlite3 dentro de la imagen, no con Python en el
  host — misma versión de SQLite que la aplicación, comprobable con la suite y sin
  dependencias nuevas en el host — si no conviene, `sqlite3.backup` de Python sigue siendo
  una alternativa equivalente.
- Ruling: destino en `backups/sqlite` del checkout central, fuera del montaje `data` —
  aprovecha el único disco disponible sin exponer las copias a web/MCP — no protege de la
  pérdida del disco: la segunda copia queda como decisión.
- Ruling: ensayos Docker en Docker Desktop local con un stack sintético que imita
  arturo-dev — no actuar en el host compartido antes de la autorización — no ejercita el
  `chown 1000` de Linux; se comprueba en el ensayo real tras activar las copias.
- Ruling: no forzar la renovación de las sesiones MCP stdio abiertas — el esquema no cambia
  y cortarlas interrumpiría trabajo de otras sesiones; se renuevan al reconectar — si se
  requiere, basta reiniciar esos clientes.
- Ruling: `verify-demo` no neutraliza `DOCKER_HOST`/`DOCKER_CONTEXT` — en macOS el contexto
  `desktop-linux` es el normal y forzarlo rompería el uso legítimo; nombres, datos y puertos
  siguen siendo privados — con un daemon remoto la sonda de puerto sería solo local.
- Ruling: sin test de escrituras concurrentes durante `backup()` — la coherencia la garantiza
  la API de backup de SQLite, que reinicia la copia si otra conexión escribe; el test de WAL
  prueba la parte nuestra — si fallara, la copia no pasaría `integrity_check`.
