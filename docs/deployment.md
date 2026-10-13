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

Orden de cada actualización: imagen candidata con otra etiqueta, pruebas, copia
`pre-update` y solo después el cambio de imagen. `docker compose build app` sin
`SECURITY_INBOX_IMAGE` reetiqueta `security-inbox:local` en el acto, y la siguiente
sesión MCP abriría la base con la imagen nueva antes de la copia: si esa versión migra
el esquema, la copia llegaría tarde.

Desde `/root/Proyectos/security-inbox`, con el checkout sin cambios versionados. El
subshell con `set -e` se detiene en el primer fallo: si la copia `pre-update` falla, la
imagen en servicio no cambia. Anota las dos versiones que imprime.

```sh
(
  set -euo pipefail
  old=$(git rev-parse --short HEAD)
  git pull --ff-only origin main
  new=$(git rev-parse --short HEAD)
  echo "en servicio: $old; candidata: $new"
  test "$new" != "$old"
  SECURITY_INBOX_IMAGE=security-inbox:$new SECURITY_INBOX_REVISION=$new docker compose build app
  docker run --rm --network none security-inbox:$new sh scripts/test-container.sh
  docker run --rm --network none security-inbox:$new npm run typecheck
  scripts/backup.sh pre-update                          # con la imagen en servicio
  docker tag security-inbox:local security-inbox:$old  # para volver atrás
  docker tag security-inbox:$new security-inbox:local
  docker compose up -d web
  docker compose ps web
  curl --fail http://192.168.0.130:3300/
)
```

**Primera vez con esta rutina.** La imagen en servicio no incluye la herramienta de
copias ni existe aún su directorio. En el mismo bloque, sustituye la línea de
`scripts/backup.sh pre-update` por estas dos; la candidata abre la base en solo lectura
y nunca la migra. Activa el timer después del cambio de imagen («Copias de la base»).

```sh
  install -d -m 700 -o 1000 -g 1000 backups/sqlite
  SECURITY_INBOX_BACKUP_IMAGE=security-inbox:$new SECURITY_INBOX_BACKUP_APP_VERSION=$old \
    scripts/backup.sh pre-update
```

Las sesiones MCP stdio abiertas siguen con la imagen anterior hasta que su cliente se
reconecta; mientras el esquema no cambie son compatibles. Si la versión migra el
esquema, cierra antes esos clientes (`docker ps --filter
label=com.docker.compose.service=mcp`): un proceso con una imagen que solo admite un
esquema anterior falla al abrir la base en lugar de escribir en ella.

Volver atrás sin migración: `docker tag security-inbox:$old security-inbox:local` y
`docker compose up -d web`. Tras una migración hay que restaurar además la copia
`pre-update` (ver «Recuperar»): la imagen antigua no abre el esquema nuevo.

El esquema v5 está aplicado en arturo-dev desde el 4 de octubre (copia previa
`data/backups/before-v5-20261004T183337Z.sqlite`).

No ejecutar `seed` ni `demo` sobre la base compartida: añaden fixtures. Para el
recorrido completo, `scripts/verify-demo.sh` (abajo).

## Copias de la base

- `scripts/backup.sh` ejecuta `node dist/src/storage/backup-cli.js` dentro de la imagen,
  sin red, con la raíz de solo lectura y montando solo `data` y el directorio de copias.
  Usa la API de backup de SQLite, que lee una instantánea coherente a través del WAL;
  abre la base en solo lectura y nunca la migra.
- Destino: `/root/Proyectos/security-inbox/backups/sqlite` (`0700`, UID 1000), fuera
  del montaje `data` de web y MCP y de Git. Está en el mismo disco que la base: cubre
  errores, migraciones fallidas y borrados, no la pérdida del disco del contenedor.
- Nombre `security-inbox-<daily|pre-update>-<UTC>-schema<N>-<versión>.sqlite` y un
  manifiesto `.json` con tamaño, SHA-256, esquema, versión y conteos. La copia se escribe
  como temporal, pasa `integrity_check` y `foreign_key_check`, queda en un solo archivo
  `0600` y se publica sin sobrescribir nada. El manifiesto va el último: sin manifiesto
  que coincida con sus bytes no hay copia válida.
- `security-inbox-backup.timer` (`ops/systemd/`) lanza cada día hacia las 03:40
  `scripts/backup.sh daily`. Tras una copia válida conserva las siete diarias válidas más
  recientes. La retención no toca copias `pre-update`, copias manuales (`data/backups/`,
  `backups/2026…`), archivos sin manifiesto ni copias cuyo SHA-256 ya no coincide.
- Un fallo deja el servicio en `systemctl --failed` y el motivo en
  `journalctl -u security-inbox-backup`. `scripts/backup.sh status` sale con 1 si no hay
  una copia diaria válida de menos de 36 horas (una `pre-update` reciente no lo oculta) e
  informa de los temporales `.partial` que deje una ejecución interrumpida; se borran a
  mano por nombre exacto.
- Las copias `pre-update` se conservan mientras haga falta volver a la versión anterior y
  se borran a mano, por nombre exacto.

Activación, una vez, como root en arturo-dev y con `security-inbox:local` ya en una
versión que incluya `scripts/backup.sh`:

```sh
install -d -m 700 -o 1000 -g 1000 /root/Proyectos/security-inbox/backups/sqlite
install -m 644 ops/systemd/security-inbox-backup.service \
  ops/systemd/security-inbox-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now security-inbox-backup.timer
systemctl start security-inbox-backup.service
scripts/backup.sh status
```

## Recuperar

`restore` nunca escribe sobre un archivo existente ni junto a un `-wal`/`-shm`; comprueba
el manifiesto si existe (las copias manuales no lo tienen), la integridad, las claves
foráneas y el esquema, y rechaza un esquema más nuevo que el de la imagen. Usa una imagen
que admita el esquema de la copia (figura en su nombre). Las copias manuales antiguas
(`data/backups/before-*.sqlite`) pueden conservar la cabecera WAL: cópialas primero a la
carpeta privada del ensayo y restaura desde allí, no desde un montaje de solo lectura.

Ensayo sin tocar la base compartida: al activar las copias, tras cambiar este
procedimiento o tras una migración, y si no, cada trimestre.

```sh
dir=$(mktemp -d /tmp/security-inbox-restore.XXXXXX); chmod 700 "$dir"; chown 1000:1000 "$dir"
copy=$(basename "$(ls -t backups/sqlite/security-inbox-daily-*.sqlite | head -1)")
docker run --rm --network none --read-only --tmpfs /tmp \
  --mount type=bind,source="$PWD/backups/sqlite",target=/backups,readonly \
  --mount type=bind,source="$dir",target=/restore \
  security-inbox:local node dist/src/storage/backup-cli.js restore "/backups/$copy" /restore/security-inbox.sqlite
docker run -d --name security-inbox-restore-check -p 127.0.0.1:3391:3300 \
  -e SECURITY_INBOX_DB=/restore/security-inbox.sqlite -e SECURITY_INBOX_CONTAINER=true \
  -e SECURITY_INBOX_WEB_ORIGIN=http://127.0.0.1:3391 \
  --mount type=bind,source="$dir",target=/restore security-inbox:local npm run web
for _ in $(seq 1 30); do curl -fs http://127.0.0.1:3391/ >/dev/null && break; sleep 1; done
curl -fs http://127.0.0.1:3391/api/projects \
  | python3 -c 'import json, sys; print(len(json.load(sys.stdin)["projects"]))'
docker stop security-inbox-restore-check && docker rm security-inbox-restore-check
rm -rf -- "$dir"
```

Restauración real, solo con autorización expresa:

1. Elegir la copia (`copy=<nombre>.sqlite`) y una imagen que admita su esquema
   (`image=security-inbox:<versión>`).
2. `docker compose stop web` y cerrar las sesiones MCP; `docker ps --filter
   label=com.docker.compose.project=security-inbox` no debe listar ningún proceso.
3. Apartar sin borrar la base actual:

   ```sh
   stamp=$(date -u +%Y%m%dT%H%M%SZ)
   install -d -m 700 -o 1000 -g 1000 "data/replaced-$stamp"
   mv data/security-inbox.sqlite* "data/replaced-$stamp/"
   ```

4. Restaurar en la ruta de la base, ahora libre:

   ```sh
   docker run --rm --network none --read-only --tmpfs /tmp \
     --mount type=bind,source="$PWD/backups/sqlite",target=/backups,readonly \
     --mount type=bind,source="$PWD/data",target=/app/data \
     "$image" node dist/src/storage/backup-cli.js restore "/backups/$copy" /app/data/security-inbox.sqlite
   ```

   Si una sesión MCP se conectó entre los pasos 3 y 4, habrá creado una base vacía y
   `restore` se negará a escribir encima: cierra esa sesión, aparta también esos archivos
   y repite el paso 4.
5. `docker tag "$image" security-inbox:local`, `docker compose up -d web` y comprobar
   la web y una sesión MCP.

## Verificar la demo sin tocar la instalación

`scripts/verify-demo.sh` construye la imagen con una etiqueta privada, pasa la suite
dentro del contenedor, siembra una base sintética, levanta la web en
`127.0.0.1:${SECURITY_INBOX_VERIFY_PORT:-3390}`, prueba el MCP stdio y la persistencia
tras reiniciar. Usa una raíz temporal privada, carpetas sintéticas y un proyecto Compose
`security-inbox-verify-<id>`; no lee `data/` ni `.env`. Rechaza 3300, 3301 o un puerto
ocupado y solo elimina sus recursos tras terminar bien. Si falla o se interrumpe,
conserva raíz, logs, contenedores parados e imagen, y muestra sus nombres.

Se ensayó con un stack sintético que imita esta instalación (proyecto `security-inbox`,
`.env` con `COMPOSE_FILE` y la red del proxy): contenedor, imagen y datos de ese stack
no cambiaron tras un recorrido correcto ni tras uno interrumpido.

## Mantenimiento

- Cada mes: `scripts/backup.sh status` y `systemctl list-timers
  security-inbox-backup.timer`; y `npm audit --package-lock-only --ignore-scripts` en un
  checkout privado de `origin/main`. Los avisos se resuelven en un lote pequeño en una
  rama (versiones fijas, sin `audit fix --force`, suite, typecheck, build y revisión del
  diff) y se instalan con «Actualizar»; nada se actualiza solo en el servidor.
- Tras cambiar router, VPN, proxy o bind, repetir solo esta comprobación:

  ```sh
  ss -ltnp | grep -E ':(3300|3301)\b'
  docker ps --format '{{.Names}} {{.Ports}}' | grep -E '3300|3301'
  tailscale serve status
  tailscale funnel status
  ```

  Esperado: web en `127.0.0.1:3300`; el proxy en `192.168.0.130:3300` y
  `127.0.0.1:3301`; `tailscale serve` de `:3300` hacia `127.0.0.1:3301`, «tailnet only»,
  sin funnel.
- Ensayo de restauración según «Recuperar».

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

El tráfico va en **HTTP plano**: el token viaja en claro. Publícalo fuera de
loopback solo por un enlace de confianza (la VPN de casa, WireGuard o un proxy TLS),
nunca expuesto a internet. Usa tokens aleatorios como el de arriba: el servidor solo
exige 32 caracteres, no mide su entropía. Los navegadores envían `Origin` y se rechazan
salvo que estén en `SECURITY_INBOX_MCP_ALLOWED_ORIGINS`; los clientes de terminal no lo
envían.

El token se entrega a su dueño por un canal privado y no se commitea. Para revocar o
añadir clientes, edita `data/mcp-tokens` y `docker compose --profile mcp-http restart
mcp-http`. Sin `SECURITY_INBOX_MCP_BIND` publica solo en loopback.
En arturo-dev `127.0.0.1:3301` ya lo publica el proxy para la tailnet: con el bind por
defecto, `mcp-http` no podría publicar su puerto.
Reiniciar los clientes MCP después de actualizar la imagen. Para parar solo la
web: `docker compose stop web`; los datos permanecen en `data`.

Las instrucciones de los agentes y las configuraciones de Codex se encuentran
en [mcp-and-skill.md](mcp-and-skill.md).
