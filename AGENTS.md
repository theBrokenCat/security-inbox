# Instrucciones del proyecto

## Comandos

- Instalar: `npm ci` con Node.js 24.
- Verificar: `npm test`, `npm run typecheck`, `npm run build`.
- Demo: `npm run seed` y `npm run demo`.
- Docker: solo `app` declara `build`; seed/tests usan `docker compose run --rm -T app ...`
  y MCP usa `docker compose run --rm -T mcp` sobre `node dist/src/mcp/server.js`.

## Arquitectura

- El servicio compartido está en `src/core` y persiste en SQLite mediante
  `src/storage`; web y MCP son adaptadores separados.
- `src/projects/directory-manager.ts` es la única frontera de exploración del
  filesystem; web y MCP deben usarla y nunca resolver rutas por su cuenta.
- La identidad del usuario se resuelve **en el adaptador**, nunca en `src/core`:
  la web lee la cookie `si_user` y el MCP lee `SECURITY_INBOX_USER`. El servicio
  solo acepta un `ownerId` ya resuelto.
- `projects.owner_id` es `NOT NULL` con clave foránea a `users`. La migración v3
  reconstruye la tabla; SQLite obliga a hacerlo con `foreign_keys = OFF` para que
  `legacy_alter_table` impida reescribir la clave foránea de `findings`.
- `src/demo` contiene únicamente fixtures sintéticos y el recorrido local del
  servicio. La base por defecto es `data/security-inbox.sqlite`.
- La imagen incluye `views` y `public` para que web y sus pruebas funcionen;
  código/dependencias quedan root-owned y solo `/app/data` se entrega a `node`.
- Compose usa `node:24-bookworm`, monta `./data`, usa el bridge por defecto del
  proyecto y publica la web solo en `127.0.0.1:3300`. Con
  `SECURITY_INBOX_CONTAINER=true`, la web escucha dentro en `0.0.0.0:3300`.
- En Linux, `./data` y sus archivos deben ser escribibles por UID/GID 1000; usa
  `chown -R 1000:1000 data` si un SQLite heredado pertenece a root.
- `SECURITY_INBOX_PROJECTS_ROOT` limita el árbol accesible;
  `SECURITY_INBOX_PROJECTS_DISPLAY_ROOT` es la ruta persistida/visible. Compose
  monta `${SECURITY_INBOX_PROJECTS_HOST_ROOT:-/root/Proyectos}` read-only.

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
