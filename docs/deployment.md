# Instalación central en arturo-dev

- Web en casa: `http://192.168.0.130:3300`.
- SSH: `arturo-dev`, actualmente `root@192.168.0.130`.
- Repositorio: `/root/Proyectos/security-inbox`.
- Persistencia: `/root/Proyectos/security-inbox/data/security-inbox.sqlite`.
- Usuario MCP: `thebrokencat`; es atribución, no autenticación.
- Web: servicio Compose `web`, con `restart: unless-stopped`; Docker arranca con el servidor.
- MCP: un proceso efímero por cliente que comparte el SQLite persistente.

La dirección web requiere acceso a la red de casa o a su VPN. El MCP requiere
SSH al alias `arturo-dev`, sin instalar Node ni ejecutar la web en el equipo
del agente. La selección de carpetas en la web corresponde al servidor; los
agentes pueden registrar sus carpetas locales con `external: true`.

El `.env` del servidor contiene estos ajustes, sin credenciales:

```dotenv
SECURITY_INBOX_USER=thebrokencat
SECURITY_INBOX_DEFAULT_USER=thebrokencat
SECURITY_INBOX_WEB_BIND=192.168.0.130
SECURITY_INBOX_WEB_ORIGIN=http://192.168.0.130:3300
```

La publicación por defecto sigue siendo loopback. `SECURITY_INBOX_WEB_ORIGIN`
declara un origen exacto sin barra final, ruta ni query; Host, Origin y CSRF se
comprueban también en la instalación remota. `.env`, datos y configuración de
credenciales quedan fuera del contexto Docker y de Git.

## Actualizar

Antes de migrar, crear una copia consistente mediante la API `sqlite3.backup`
de Python o el comando `.backup` de SQLite; no copiar solamente el `.sqlite`
si hay un WAL activo. La actualización inicial guardó una copia en
`data/backups/before-central-deploy-20261004T091451Z.sqlite`.

Desde `/root/Proyectos/security-inbox`:

```sh
git pull --ff-only origin main
docker compose build app
docker compose run --rm -T app npm test
docker compose run --rm -T app npm run typecheck
docker compose up -d web
docker compose ps web
curl --fail http://192.168.0.130:3300/
```

No ejecutar `seed` ni `demo` sobre la base compartida: añaden fixtures.
Reiniciar los clientes MCP después de actualizar la imagen. Para parar solo la
web: `docker compose stop web`; los datos permanecen en `data`.

Las instrucciones de los agentes y las configuraciones de Codex se encuentran
en [mcp-and-skill.md](mcp-and-skill.md).
