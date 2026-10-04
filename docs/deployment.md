# Instalación central en arturo-dev

- Web en casa: `http://192.168.0.130:3300`.
- SSH: `arturo-dev`, actualmente `root@192.168.0.130`.
- Repositorio: `/root/Proyectos/security-inbox`.
- Persistencia: `/root/Proyectos/security-inbox/data/security-inbox.sqlite`.
- Usuario MCP: `thebrokencat`; es atribución, no autenticación.
- Web: servicio Compose `web`, con `restart: unless-stopped`; Docker arranca con el servidor.
- Acceso LAN: proxy existente `security-inbox-private-proxy`, que se conserva.
  `compose.remote.yaml` conecta la nueva web a su red `security-inbox-private`
  con la dirección `192.168.32.3` y el alias de su backend anterior.
- MCP: un proceso efímero por cliente que comparte el SQLite persistente.

La dirección web requiere acceso a la red de casa o a su VPN. El MCP requiere
SSH al alias `arturo-dev`, sin instalar Node ni ejecutar la web en el equipo
del agente. La selección de carpetas en la web corresponde al servidor; los
agentes pueden registrar sus carpetas locales con `external: true`.

El `.env` del servidor contiene estos ajustes, sin credenciales:

```dotenv
SECURITY_INBOX_USER=thebrokencat
SECURITY_INBOX_DEFAULT_USER=thebrokencat
SECURITY_INBOX_WEB_BIND=127.0.0.1
SECURITY_INBOX_WEB_ORIGIN=http://192.168.0.130:3300
COMPOSE_FILE=compose.yaml:compose.remote.yaml
```

La publicación por defecto sigue siendo loopback. `SECURITY_INBOX_WEB_ORIGIN`
declara un origen exacto sin barra final, ruta ni query; Host, Origin y CSRF se
comprueban también en la instalación remota. `.env`, datos y configuración de
credenciales quedan fuera del contexto Docker y de Git.

En este host la web publica loopback y el proxy conserva la publicación LAN.
El contenedor anterior `security-inbox-live-web` queda parado y desconectado de
la red privada; no arrancarlo a la vez que la nueva web. El override es específico
de esta instalación y presupone la red y el proxy existentes.

## Actualizar

Antes de migrar, crear una copia consistente mediante la API `sqlite3.backup`
de Python o el comando `.backup` de SQLite; no copiar solamente el `.sqlite`
si hay un WAL activo. La actualización inicial guardó una copia en
`data/backups/before-central-deploy-20261004T091451Z.sqlite`.

Desde `/root/Proyectos/security-inbox`:

```sh
git pull --ff-only origin main
docker compose build app
docker compose run --rm -T app sh scripts/test-container.sh
docker compose run --rm -T app npm run typecheck
docker compose up -d web
docker compose ps web
curl --fail http://192.168.0.130:3300/
```

**Esquema v5.** La primera apertura con esta versión añade `findings.external_ref`
(sin reconstruir tablas). Haz la copia de arriba antes, y reconstruye la imagen
(`docker compose build app`) antes de que ningún cliente abra la base: un MCP con la
imagen anterior rechazaría después la versión 5.

No ejecutar `seed` ni `demo` sobre la base compartida: añaden fixtures.

## MCP por HTTP (opcional)

Para clientes que no pueden lanzar un proceso por SSH. Mismas herramientas y reglas
que el MCP por stdio; el token de cada cliente dice con qué usuario escribe y sin
token válido no pasa ninguna petición. Desde `/root/Proyectos/security-inbox`:

```sh
umask 077
printf 'guzman %s\n' "$(openssl rand -hex 32)" >> data/mcp-tokens
chown 1000:1000 data/mcp-tokens
echo 'SECURITY_INBOX_MCP_BIND=192.168.0.130' >> .env   # solo si debe verse en la LAN
docker compose --profile mcp-http up -d mcp-http
```

El token se entrega a su dueño por un canal privado y no se commitea. Para revocar o
añadir clientes, edita `data/mcp-tokens` y `docker compose --profile mcp-http restart
mcp-http`. Sin `SECURITY_INBOX_MCP_BIND` publica solo en loopback.
Reiniciar los clientes MCP después de actualizar la imagen. Para parar solo la
web: `docker compose stop web`; los datos permanecen en `data`.

Las instrucciones de los agentes y las configuraciones de Codex se encuentran
en [mcp-and-skill.md](mcp-and-skill.md).
