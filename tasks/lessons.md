# Lecciones

- La imagen debe usar `node:24-bookworm`, no `node:24-slim`: la compilación
  nativa de `better-sqlite3` necesita Python, make y g++ en el host objetivo.
- El baseline remoto operativo previsto es
  `arturo-dev:/root/Proyectos/security-inbox`; esa ruta no constituye por sí
  sola evidencia de despliegue ni de ejecución remota.
- Los fixtures demo se identifican por `repositoryReference` sintético estable,
  no solo por nombre: un proyecto real homónimo debe conservarse separado.
- Docker debe copiar `views` y `public`, construir la imagen solo en `app` y
  ejecutar MCP directamente desde `dist/src/mcp/server.js`; el código y las
  dependencias permanecen root-owned y solo `/app/data` es escribible por
  `node`.
- Una red Compose marcada `internal` no publica el puerto web en `arturo-dev`;
  usa el bridge propio por defecto y restringe la publicación del host a
  `127.0.0.1`.
- En Linux, corrige recursivamente `./data` a UID/GID 1000 antes de ejecutar los
  contenedores. Cambiar solo la carpeta no arregla un archivo SQLite heredado
  `root:root`: las lecturas pasan, pero una nueva escritura falla.
