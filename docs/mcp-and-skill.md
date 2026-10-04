# MCP y skill de Security Inbox

## Preparación para ejecución nativa en el servidor

Para usar la instalación central desde otro equipo, basta la conexión SSH
descrita abajo. Solo para ejecutar la plataforma directamente se requiere
Node 24 y una instalación ya resuelta del repositorio:

```sh
npm ci
npm run build
```

El entrypoint compilado es `dist/src/mcp/server.js`. El proceso habla MCP por stdin/stdout; stdout queda reservado al protocolo. No uses `npm run mcp`: npm imprime su banner en stdout antes de iniciar el servidor. `SECURITY_INBOX_DB` selecciona el archivo SQLite. En ejecución nativa, sin raíz explícita, puedes elegir cualquier carpeta accesible por su ruta completa. `SECURITY_INBOX_PROJECTS_ROOT` limita los directorios navegables cuando se configura; `SECURITY_INBOX_PROJECTS_DISPLAY_ROOT` permite guardar la ruta real cuando la raíz accesible está montada en otra ubicación. `SECURITY_INBOX_USER` declara el slug del usuario dueño de los proyectos que registre este agente: sin él, las lecturas siguen funcionando con `scope: "all"` pero `register_project` devuelve `USER_REQUIRED`.

## Conexión nativa

Desde la raíz del repositorio, ejecuta Node directamente:

```sh
SECURITY_INBOX_DB=/absolute/path/to/security-inbox.sqlite node dist/src/mcp/server.js
```

Configuración equivalente para un cliente con `mcpServers`:

```json
{
  "mcpServers": {
    "security-inbox": {
      "command": "node",
      "args": ["/absolute/path/to/security-inbox/dist/src/mcp/server.js"],
      "env": {
        "SECURITY_INBOX_DB": "/absolute/path/to/security-inbox.sqlite",
        "SECURITY_INBOX_PROJECTS_ROOT": "/absolute/path/to/projects",
        "SECURITY_INBOX_USER": "guzman"
      }
    }
  }
}
```

Reinicia o recarga el cliente después de guardar la configuración. La conexión correcta muestra diez herramientas: `list_projects`, `list_users`, `browse_project_directories`, `register_project`, `register_finding`, `list_findings`, `get_finding`, `update_finding`, `update_finding_status` y `add_finding_note`.

`list_projects` devuelve por defecto solo los proyectos de `SECURITY_INBOX_USER`; usa `scope: "all"` para ver el inventario completo. El dueño nunca se pasa como argumento: sale de la configuración del proceso.

Flujo recomendado para agentes:

1. Si la carpeta es un clon de git, `list_projects` con `repositoryReference` (la salida de `git remote get-url origin`, en cualquier forma); si no, `list_projects` y comparar `directoryPath`.
2. Si falta y la carpeta está en el equipo del agente, `register_project` con su `directoryPath` absoluto, `external: true` y, si es un clon, `repositoryReference`. El mismo repositorio clonado en otra máquina u otra ruta resuelve al mismo proyecto; las credenciales de la URL se descartan antes de guardar. Para carpetas montadas en el servidor, alta normal y navegación opcional. Los reintentos devuelven el mismo proyecto.
3. Conservar el `projectId`, buscar posibles duplicados y gestionar detalle, edición, estado y notas con ese ID.

## Captura breve y revisión posterior

`register_finding` necesita `projectId`, `idempotencyKey`, `title` y `description`.
Admite cualquier fallo del proyecto; `severity` empieza en `unclassified` y
`evidence` puede omitirse. Añade la ubicación y el commit si ya se conocen, sin
investigar fuera de la tarea actual para completar campos opcionales.

`list_findings` devuelve `{ findings, total, limit, offset, nextOffset }`. Cada
página admite hasta 100 resultados. Sigue `nextOffset`, manteniendo los filtros,
hasta que sea `null`. Recoge toda la lista antes de editarla o cambiar estados:
el orden es por última actividad. `query` busca también en archivo y commit.

El historial devuelve `actor: { slug, name }` por evento, o `null` cuando no se
conoce el autor. El adaptador resuelve ese dato desde `SECURITY_INBOX_USER`;
los argumentos de las herramientas no pueden elegirlo. `origin` es una etiqueta
opcional independiente y por defecto vale `mcp`. La identidad es atribución,
no una comprobación de permisos.

La skill permite guardar un fallo encontrado durante otra tarea y continuar.
Cuando el usuario pide retomar pendientes, el agente recupera el detalle,
completa lo que falte, trabaja dentro del alcance solicitado y registra una
nota de cierre con la verificación. La plataforma no programa ni lanza agentes.

## Conexión central por SSH y Docker Compose

La instalación compartida vive en `arturo-dev:/root/Proyectos/security-inbox`.
Su web es `http://192.168.0.130:3300`. Los clientes no necesitan Node, Docker,
una copia del repositorio ni una base local: solo SSH con acceso a `arturo-dev`.
Compose crea un contenedor MCP efímero que comparte el SQLite del servidor.
Mantén stdio sin TTY y usa Node directamente para reservar stdout al protocolo.

Configuración en `~/.codex/config.toml` de Codex:

```toml
[mcp_servers.security-inbox]
command = "ssh"
args = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "arturo-dev", "docker", "compose", "-f", "/root/Proyectos/security-inbox/compose.yaml", "run", "--rm", "-T", "mcp"]
startup_timeout_sec = 30
```

Se puede registrar mediante `codex mcp add security-inbox -- ssh -T -o
BatchMode=yes -o ConnectTimeout=10 arturo-dev docker compose -f
/root/Proyectos/security-inbox/compose.yaml run --rm -T mcp` y ajustar el tiempo
inicial en el TOML. Véase la [configuración oficial de MCP en Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

En Codex ejecutado dentro de arturo-dev, usa `command = "docker"` y
`args = ["compose", "-f", "/root/Proyectos/security-inbox/compose.yaml", "run", "--rm", "-T", "mcp"]`, sin SSH a sí mismo.

Para clientes con `mcpServers`:

```json
{
  "mcpServers": {
    "security-inbox": {
      "command": "ssh",
      "args": ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "arturo-dev", "docker", "compose", "-f", "/root/Proyectos/security-inbox/compose.yaml", "run", "--rm", "-T", "mcp"]
    }
  }
}
```

El usuario configurado en Compose es `thebrokencat`, que ya existe en la base.
Para otro usuario, créalo desde la web y añade `-e SECURITY_INBOX_USER=su-slug`
entre `-T` y `mcp` en el comando Compose. Esa variable se resuelve en el proceso
remoto; una variable local no se transmite automáticamente por SSH.

Si el repositorio está en el equipo del agente y no está montado en el servidor,
resuelve su ruta absoluta en ese equipo y registra:

```json
{ "directoryPath": "/home/arturo/Proyectos/mi-proyecto", "external": true }
```

No se comprueba su existencia en arturo-dev ni se leen sus archivos; se guarda
como identidad del proyecto. `browse_project_directories` sigue limitado al
filesystem del servidor. Normaliza symlinks en el cliente y busca por
`directoryPath`, nunca solo por nombre. Para carpetas montadas, el alta normal
conserva las comprobaciones de acceso y canonicalización del servidor.

Para operar o actualizar el servidor, consulta [deployment.md](deployment.md).

## Instalación y activación de la skill

Copia la carpeta completa a la raíz de skills de tu cliente, conservando el nombre:

```sh
mkdir -p /absolute/path/to/codex/skills/security-inbox
cp skills/security-inbox/SKILL.md /absolute/path/to/codex/skills/security-inbox/SKILL.md
```

Inicia una sesión nueva o recarga las skills. Invócala como `$security-inbox`; los clientes con descubrimiento automático también pueden seleccionarla por su descripción. La configuración central instala la skill en `~/.codex/skills/security-inbox` y las instrucciones de [agent-instructions.md](agent-instructions.md) en `~/.codex/AGENTS.md`, tanto en el cliente como en arturo-dev. Conserva cualquier otra instrucción existente al integrar ese texto.

## Compatibilidad verificada

La prueba E2E usa exclusivamente `@modelcontextprotocol/client` 2.0.0 con `StdioClientTransport`, negocia la revisión moderna `2026-07-28`, recorre éxito y error y comprueba cierre limpio sin ruido de protocolo. No se afirma compatibilidad con otros clientes.
El mismo cliente recorrió mediante SSH/Compose en `arturo-dev` la navegación de directorios, alta y retry de proyecto, creación y edición de un hallazgo. No se afirma compatibilidad con otros clientes ni hosts.
