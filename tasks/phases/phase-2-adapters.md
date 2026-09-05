# Fase 2: adaptadores y operación

Tres implementers trabajan en paralelo tras congelar la API del núcleo. No
pueden editar `package.json`, lockfile, migraciones ni tipos compartidos.

## Writer web

**Write scope:** `src/web/**`, `views/**`, `public/**`, `test/web/**`

1. Escribir RED con `Fastify.inject` para recuentos no terminales por gravedad,
   recuento sin revisar, filtros, alta, precheck de parecidos, detalle, edición,
   estado, nota, errores, HTML escapado y estados vacíos.
2. Añadir RED para GET+POST legítimo y POST sin origen/token, origen externo,
   `Sec-Fetch-Site: cross-site` y Host no permitido.
3. Implementar rutas y plantillas Nunjucks autoescaped, CSP, token CSRF,
   allowlist de Host/Origin y binds nativo/contenedor definidos en el diseño.
4. Implementar CSS responsive de cuaderno de incidentes sin JavaScript.
5. Confirmar GREEN con `npm test -- test/web` y `npm run typecheck`.

## Writer MCP y skill

**Write scope:** `src/mcp/**`, `test/mcp/**`, `skills/security-inbox/**`, `docs/mcp-and-skill.md`

1. Escribir una prueba RED que conecte `Client` y `StdioClientTransport` de
   `@modelcontextprotocol/client@2.0.0` al proceso compilado y espere seis tools.
2. Registrar con `@modelcontextprotocol/server@2.0.0`, Zod, resultados
   estructurados y errores por código sin detalles internos ni eco de payloads.
3. Probar listado/búsqueda previa, alta, candidatos, retry, conflicto de clave,
   aislamiento, detalle, transición terminal con nota e historial por stdio.
4. Comprobar que éxito y error no añaden texto ajeno al protocolo en stdout.
5. Crear una `SKILL.md` breve con identificación de proyecto, evidencia,
   deduplicación, sospecha vs. confirmación, comprobación al resolver y respeto
   al alcance del usuario.
6. Escribir `docs/mcp-and-skill.md` con configuración genérica, activación o
   copia de la skill, comando local/SSH y compatibilidad limitada a lo probado.
7. Validar la skill y ejecutar `npm test -- test/mcp`, typecheck y build.

## Writer demo y docs

**Write scope:** `src/demo/**`, `test/demo/**`, `Dockerfile`, `compose.yaml`, `.dockerignore`, `.gitignore`, `README.md`, `AGENTS.md`, `tasks/lessons.md`

1. Escribir RED para seed idempotente: dos proyectos, seis hallazgos, cinco
   gravedades, cuatro estados y conservación tras cerrar/reabrir SQLite.
2. Implementar seed sintético y comando demo.
3. Crear imagen Node 24; Compose configura bind de contenedor `0.0.0.0`, bridge
   propio del proyecto, volumen `./data` y publicación host
   `127.0.0.1:3300:3300`; MCP no publica puertos.
4. README documenta instalación, tests, demo y túnel SSH, y enlaza la guía MCP.
5. Añadir check de patrones de secretos en fuentes/fixtures y asegurar que los
   ejemplos solo contienen valores sintéticos.
6. Registrar únicamente los clientes realmente ejecutados.

## Gate

El destino vigente es `arturo-dev:/root/Proyectos/security-inbox`; sustituye la
ruta inicial. Ningún agente puede leer Penthos. El lead espera a los tres writers, inspecciona el diff conjunto, resuelve solo
integración y ejecuta los checks afectados. Los writers no delegan ni integran.
