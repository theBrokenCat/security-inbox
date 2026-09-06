# Security Inbox

Aplicación local para registrar y revisar sospechas de seguridad por proyecto.
Registrar una sospecha no la confirma ni corrige una vulnerabilidad. Web y MCP
usan el mismo servicio y la misma base SQLite.

## Requisitos e instalación

- Node.js 24 (la imagen usa `node:24-bookworm`).
- npm y, para el flujo Docker, Docker Compose v2.

Con Node local:

```sh
nvm install 24
nvm use 24
npm ci
```

La base por defecto es `data/security-inbox.sqlite`. Se puede cambiar con
`SECURITY_INBOX_DB`.

La web registra proyectos seleccionando carpetas. En ejecución nativa,
`SECURITY_INBOX_PROJECTS_ROOT` limita el árbol navegable y por defecto es el
directorio desde el que se lanza la aplicación.

## Comandos locales

```sh
npm run seed          # dos proyectos y seis hallazgos sintéticos, idempotente
npm run demo          # seed + alta/retry/transición/historial/reapertura
npm test
npm run typecheck
npm run build
npm run web
```

`npm run web` escucha en loopback en ejecución nativa. El seed cubre las cinco
gravedades y cinco estados, conserva los UUID y no duplica eventos al repetirse.
`npm run demo` añade un hallazgo sintético de recorrido y comprueba que el retry
con `demo-route-fixed-key` devuelve el mismo UUID.

## Docker Compose

La imagen compila con `npm ci` en `node:24-bookworm` y ejecuta como el usuario no
privilegiado `node`. `./data` se monta con escritura; la raíz de proyectos se
monta read-only en `/projects`. Compose crea el bridge propio del proyecto y la
web publica solo loopback del host.

```sh
mkdir -p data
# En Linux, si data o un SQLite existente pertenecen a otro usuario:
# chown -R 1000:1000 data
docker compose build app
docker compose run --rm -T app
docker compose up -d web
curl --fail http://127.0.0.1:3300/
docker compose ps
```

La raíz Docker predeterminada es `/root/Proyectos`. Para otro host:

```sh
SECURITY_INBOX_PROJECTS_HOST_ROOT=/ruta/absoluta/Proyectos docker compose up -d web
```

Para probar MCP por stdio, conserva `-T` para no asignar un pseudo-terminal:

```sh
docker compose run --rm -T mcp
```

El proceso web recibe `SECURITY_INBOX_CONTAINER=true` y escucha dentro del
contenedor en `0.0.0.0:3300`; el host solo ve `127.0.0.1:3300`. La guía de
configuración MCP y skill está en [docs/mcp-and-skill.md](docs/mcp-and-skill.md).

Para repetir el recorrido completo de forma segura:

```sh
./scripts/verify-demo.sh
```

El script construye solo `app`, ejecuta la suite dentro de la imagen, siembra
datos, comprueba la web en loopback, cierra stdin del MCP, verifica stdout sin
banners y repite `npm run demo` antes y después de reiniciar `web`. Hace cleanup
de contenedores y red, pero conserva `./data`.

## Flujo operativo completo

1. Arranca `web`, pulsa **Añadir proyecto** y selecciona una carpeta; el nombre
   y la ubicación se registran automáticamente.
2. Un agente comienza con `list_projects`. Si falta la carpeta, usa
   `browse_project_directories` y `register_project`; después conserva el UUID.
3. Lista hallazgos, comprueba candidatos parecidos y
   registra uno con una clave de idempotencia estable.
4. Repite la misma petición: debe devolver el mismo UUID y no crear otra fila.
5. Usa `update_finding`, cambia el estado con una nota cuando corresponda y
   consulta el detalle para comprobar el historial append-only.
6. Reinicia `web` y vuelve a conectar MCP; el UUID y los eventos deben seguir en
   `./data`.

Si el stack ya está desplegado en el equipo remoto, el túnel para abrir la web
localmente es:

```sh
ssh -N -L 3300:127.0.0.1:3300 arturo-dev
```

El destino operativo previsto es `arturo-dev:/root/Proyectos/security-inbox`.

## Limitaciones verificadas

- Es una aplicación local de una sola persona; no incluye autenticación ni
  despliegue público.
- Las entradas son sospechas, no confirmaciones automáticas, detección externa
  ni remediación.
- MCP se sirve por stdio y requiere un cliente configurado; `-T` es necesario
  en Compose para mantener stdout reservado al protocolo.
- Solo se documenta Node 24, Docker Compose v2 y el flujo remoto indicado; no se
  afirma compatibilidad con otros hosts.
- No se incluyen secretos ni credenciales en fixtures, imagen, Compose o docs.
- No se siguen symlinks que salgan de la raíz configurada y la web nunca lee el
  contenido de los archivos del proyecto.

Para apagar el stack: `docker compose down`. La eliminación de `./data` es una
acción separada y borra la persistencia local.
