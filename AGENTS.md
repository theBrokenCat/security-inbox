# Instrucciones del proyecto

## Comandos

- Instalar: `npm ci` con Node.js 24.
- Verificar: `npm test`, `npm run typecheck`, `npm run build`.
- Demo: `npm run seed` y `npm run demo`.
- Docker: solo `app` declara `build`; seed/tests usan `docker compose run --rm -T app ...`
  y MCP usa `docker compose run --rm -T mcp` sobre `node dist/src/mcp/server.js`.
  Las pruebas usan `app sh scripts/test-container.sh` para compilar en `/tmp`
  sin cambiar los permisos del código de la imagen.

## Arquitectura

- El servicio compartido está en `src/core` y persiste en SQLite mediante
  `src/storage`; web y MCP son adaptadores separados.
- `src/projects/directory-manager.ts` es la única frontera de exploración del
  filesystem; web y MCP deben usarla y nunca resolver rutas por su cuenta.
- La identidad del usuario se resuelve **en el adaptador**, nunca en `src/core`:
  la web lee la cookie `si_user` y el MCP lee `SECURITY_INBOX_USER`. El servicio
  solo acepta un `ownerId` ya resuelto.
- Los cambios de incidencias aceptan un `actor` ya resuelto por el adaptador.
  El historial guarda una copia de slug/nombre, sin FK a usuarios, para mantener
  la atribución al eliminar un usuario. El origen libre no sustituye al autor.
- Una incidencia necesita título y contexto; gravedad empieza en `unclassified`
  y evidencia es opcional. El esquema v4 reconstruye `findings` con foreign keys
  desactivadas y `legacy_alter_table`, conservando UUID, fingerprints e historial.
- Web y MCP usan `listFindingsPage`; MCP devuelve `nextOffset` y la web conserva
  filtros al paginar. Recoger las páginas antes de cambiar la actividad.
- `src/core/secrets.ts` rechaza con `SECRET_DETECTED` (web 422, MCP con los campos)
  cualquier alta, edición, nota o nota de cierre que parezca llevar una credencial:
  claves privadas, tokens conocidos, `usuario:clave@` en URLs y asignaciones tipo
  `PASSWORD=valor`. Se rechaza, no se enmascara, y el error nunca repite el valor.
  Prima la precisión: la prosa sobre contraseñas y los marcadores (`<redacted>`,
  `${VAR}`, `****`) pasan.
- El esquema v5 añade `findings.external_ref` (texto libre, hasta 200) con `ADD
  COLUMN`, sin reconstruir: enlaza el hallazgo con el trabajo que lo sigue fuera
  (una tarea `T-044`, una línea de backlog, una URL). `list_findings` filtra por él
  exacto. Solo entra en el fingerprint cuando tiene valor, para que los reintentos de
  hallazgos anteriores a v5 sigan siendo idempotentes.
- `src/mcp/http.ts` sirve las mismas herramientas por HTTP (`/mcp`, perfil Compose
  `mcp-http`, puerto 3301, loopback por defecto) con un servidor nuevo por petición.
  `src/mcp/tokens.ts` lee `SECURITY_INBOX_MCP_TOKENS_FILE` (`<slug> <token>` por línea,
  tokens de 32+ caracteres, solo se guardan sus SHA-256). El token es el equivalente
  HTTP de `SECURITY_INBOX_USER`: atribución resuelta en el adaptador. Lo que añade es
  acceso al transporte: sin token conocido no llega nada al MCP.
- `src/web/read-api.ts` añade a la web una API JSON de solo lectura (`/api/projects…`)
  y `/projects/:id/export.md`. Reutiliza el control de Host y la validación del
  servicio, no escribe y no pide CSRF; sus errores son JSON con los códigos públicos.
  `scope=mine` lee la cookie: atribución, no permiso.
- `projects.owner_id` es `NOT NULL` con clave foránea a `users`. La migración v3
  reconstruye la tabla; SQLite obliga a hacerlo con `foreign_keys = OFF` para que
  `legacy_alter_table` impida reescribir la clave foránea de `findings`.
- `src/demo` contiene únicamente fixtures sintéticos y el recorrido local del
  servicio. La base por defecto es `data/security-inbox.sqlite`.
- La imagen incluye `views` y `public` para que web y sus pruebas funcionen;
  código/dependencias quedan root-owned y solo `/app/data` se entrega a `node`.
- Compose usa `node:24-bookworm`, monta `./data`, usa el bridge por defecto del
  proyecto y publica por defecto en `127.0.0.1:3300`. Para la instalación central,
  `SECURITY_INBOX_WEB_BIND` y `SECURITY_INBOX_WEB_ORIGIN` declaran la IP y el origen
  exactos permitidos, conservando los controles de Host, Origin y CSRF. Con
  `SECURITY_INBOX_CONTAINER=true`, la web escucha dentro en `0.0.0.0:3300`.
- En Linux, `./data` y sus archivos deben ser escribibles por UID/GID 1000; usa
  `chown -R 1000:1000 data` si un SQLite heredado pertenece a root.
- En ejecución nativa, sin raíz explícita, el selector empieza en la carpeta
  personal y permite subir o indicar cualquier `directoryPath` absoluto accesible.
  `directory-manager` resuelve también rutas completas y conserva la identidad
  canónica de los symlinks. `relativePath` sigue siendo compatible.
- `SECURITY_INBOX_PROJECTS_ROOT`, si se configura, limita el árbol accesible;
  `SECURITY_INBOX_PROJECTS_DISPLAY_ROOT` es la ruta persistida/visible. Compose
  monta `${SECURITY_INBOX_PROJECTS_HOST_ROOT:-/root/Proyectos}` read-only.
- `register_project` y `list_projects` aceptan `repositoryReference` (remoto de git en
  cualquier forma). `src/core/repository-reference.ts` lo normaliza a `host/ruta`
  sin credenciales; en el alta gana a `directoryPath`, de modo que el mismo repo en
  dos máquinas es un solo proyecto, y un proyecto registrado solo por ruta adopta la
  referencia la primera vez que llega. `createProject` también normaliza. Las
  credenciales se descartan con cualquier esquema o forma (todo lo anterior al último
  `@` de la autoridad) y la referencia y la descripción pasan además por
  `assertNoSecrets`. Es atribución: el primero que registra una referencia se queda
  el proyecto, igual que con `directoryPath`; no hay propiedad que verificar.
- `register_project` acepta `external: true` con `directoryPath` absoluto para
  carpetas del equipo del agente. Solo registra su identidad, sin explorar ni
  leer esa ruta en el servidor. El agente resuelve sus symlinks antes de enviarla.
- La bandeja compartida está en `arturo-dev:/root/Proyectos/security-inbox`, web
  `http://192.168.0.130:3300`. Usar el MCP `security-inbox` para fallos incidentales
  fuera de la tarea actual, comprobar duplicados y continuar; no levantar otra
  base local. La conexión e instalación de la skill se describen en
  `docs/mcp-and-skill.md`.

## Límites

- No guardar secretos, credenciales ni tokens reales en código, fixtures,
  documentación, imagen o Compose.
- No leer ni modificar Penthos desde este proyecto.
- Los agentes identifican proyectos por `directoryPath` y `projectId`; nunca por
  nombre solamente. No se implementa borrado en esta iteración.
- El usuario es atribución, no autorización: no escribir código que trate la
  cookie ni `SECURITY_INBOX_USER` como una comprobación de permisos.
- El color se toma de un conjunto cerrado validado en el `CHECK` y viaja al CSS
  como clase, nunca como `style` inline: la CSP es `style-src 'self'`.
- Los iconos viven en `views/icons.njk` como SVG en línea y son decorativos
  (`aria-hidden`): con `img-src 'self'` cualquier sprite o fuente externa
  fallaría sin aviso, y el texto debe seguir llevando el significado.
- El único borrado del proyecto es el de un usuario sin proyectos. `owner_id` es
  `NOT NULL`, así que traspasar es requisito previo, nunca una consecuencia
  automática.
- La portada usa una sola cuadrícula de tarjetas. `listProjects` ordena por la
  actividad más reciente del proyecto o de cualquiera de sus hallazgos; nombre
  y UUID solo desempatan. En las tarjetas, crítica usa negro y alta rojo.
