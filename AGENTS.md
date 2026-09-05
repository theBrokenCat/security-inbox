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
- `src/demo` contiene únicamente fixtures sintéticos y el recorrido local del
  servicio. La base por defecto es `data/security-inbox.sqlite`.
- La imagen incluye `views` y `public` para que web y sus pruebas funcionen;
  código/dependencias quedan root-owned y solo `/app/data` se entrega a `node`.
- Compose usa `node:24-bookworm`, monta `./data`, usa el bridge por defecto del
  proyecto y publica la web solo en `127.0.0.1:3300`. Con
  `SECURITY_INBOX_CONTAINER=true`, la web escucha dentro en `0.0.0.0:3300`.
- En Linux, `./data` y sus archivos deben ser escribibles por UID/GID 1000; usa
  `chown -R 1000:1000 data` si un SQLite heredado pertenece a root.

## Límites

- No guardar secretos, credenciales ni tokens reales en código, fixtures,
  documentación, imagen o Compose.
- No leer ni modificar Penthos desde este proyecto.
