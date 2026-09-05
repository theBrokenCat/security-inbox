# MCP y skill de Security Inbox

## Preparación

Security Inbox requiere Node 24 y una instalación ya resuelta del repositorio:

```sh
npm install
npm run build
```

El entrypoint compilado es `dist/src/mcp/server.js`. El proceso habla MCP por stdin/stdout; stdout queda reservado al protocolo. No uses `npm run mcp`: npm imprime su banner en stdout antes de iniciar el servidor. `SECURITY_INBOX_DB` selecciona el archivo SQLite y, si se omite, usa `data/security-inbox.sqlite` relativo al directorio de trabajo.

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
        "SECURITY_INBOX_DB": "/absolute/path/to/security-inbox.sqlite"
      }
    }
  }
}
```

Reinicia o recarga el cliente después de guardar la configuración. La conexión correcta muestra exactamente `list_projects`, `register_finding`, `list_findings`, `get_finding`, `update_finding_status` y `add_finding_note`.

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
El mismo cliente también recorrió alta, retry idempotente, cambio de estado y detalle mediante la receta SSH/Compose anterior en `arturo-dev`. No se afirma compatibilidad con otros clientes ni hosts.
