# MCP y skill de Security Inbox

## Preparación

Security Inbox requiere Node 24 y una instalación ya resuelta del repositorio:

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

1. `list_projects` y comparar `directoryPath`.
2. Si falta, `browse_project_directories` y `register_project` con su `directoryPath` absoluto o el `relativePath` devuelto. Sin ruta, la navegación nativa comienza en la carpeta personal; puedes subir hasta la raíz del filesystem. En Docker solo están disponibles las carpetas montadas. Ambas formas de selección conservan la misma identidad canónica y los reintentos devuelven el mismo proyecto.
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

## Ejemplo por SSH y Docker Compose

Compose crea el contenedor efímero del servicio MCP, así que no requiere asumir un contenedor ya iniciado. Para el destino remoto previsto, conserva stdio sin TTY con:

```sh
ssh -T arturo-dev docker compose -f /root/Proyectos/security-inbox/compose.yaml run --rm -T mcp
```

Configuración equivalente para un cliente con `mcpServers`:

```json
{
  "mcpServers": {
    "security-inbox": {
      "command": "ssh",
      "args": [
        "-T",
        "arturo-dev",
        "docker",
        "compose",
        "-f",
        "/root/Proyectos/security-inbox/compose.yaml",
        "run",
        "--rm",
        "-T",
        "mcp"
      ]
    }
  }
}
```

Para otro host, sustituye el alias SSH y la ruta del archivo Compose. Compose puede escribir mensajes operativos en stderr; stdout queda reservado al protocolo MCP. El lead verificó esta receta en `arturo-dev`; la prueba automatizada no cubre SSH ni Docker.

## Instalación y activación de la skill

Copia la carpeta completa a la raíz de skills de tu cliente, conservando el nombre:

```sh
mkdir -p /absolute/path/to/codex/skills/security-inbox
cp skills/security-inbox/SKILL.md /absolute/path/to/codex/skills/security-inbox/SKILL.md
```

Inicia una sesión nueva o recarga las skills. Invócala como `$security-inbox`; los clientes con descubrimiento automático también pueden seleccionarla por su descripción. En este repositorio solo se valida la estructura de la skill, no su activación en otros hosts.

## Compatibilidad verificada

La prueba E2E usa exclusivamente `@modelcontextprotocol/client` 2.0.0 con `StdioClientTransport`, negocia la revisión moderna `2026-07-28`, recorre éxito y error y comprueba cierre limpio sin ruido de protocolo. No se afirma compatibilidad con otros clientes.
El mismo cliente recorrió mediante SSH/Compose en `arturo-dev` la navegación de directorios, alta y retry de proyecto, creación y edición de un hallazgo. No se afirma compatibilidad con otros clientes ni hosts.
