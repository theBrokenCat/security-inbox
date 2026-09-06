# Security Inbox — plan de acción

**Goal:** entregar una demo local persistente con web y MCP sobre las mismas reglas.
**Stack:** Node 24, TypeScript, Fastify, Nunjucks, SQLite, Zod, MCP SDK v2, Vitest, Docker Compose.

## Fase 1 — Bootstrap y contrato

- [x] Congelar estructura, DTOs, esquema SQLite y dependencias.
- [x] Escribir pruebas RED de dominio, validación, aislamiento e idempotencia.
- [x] Implementar la capa compartida y dejarla GREEN.
- [x] Probar cierre/reapertura y dos conexiones concurrentes sobre un archivo real.
- [x] Sincronizar al host remoto y verificar en Node 24.

## Fase 2 — Adaptadores en paralelo

- [x] Implementar web, protección de origen/CSRF y pruebas de rutas.
- [x] Implementar MCP stdio, skill y prueba con cliente real.
- [x] Implementar seed, Docker y documentación operativa.
- [x] Integrar los tres scopes sin reabrir el contrato compartido.

## Fase 3 — Demo

- [x] Construir imagen e inicializar datos sintéticos.
- [x] Recorrer alta MCP, reintento idempotente, consulta web e historial.
- [x] Comprobar selección por UUID, candidatos parecidos y seis fixtures variados.
- [x] Reiniciar contenedores y comprobar persistencia.

## Fase 4 — Gates

- [x] Ejecutar revisión de especificación y calidad/seguridad sobre snapshot estable.
- [x] Aplicar lotes de corrección consolidados y resets de contrato documentados.
- [x] Ejecutar test, typecheck, build y demo E2E completos.
- [x] Buscar secretos/tokens accidentales y comprobar stdout MCP limpio.
- [x] Preparar solo cambios propios con `git add`; no commit ni push.
- [x] Entregar resumen de funcionamiento, comandos, verificaciones y limitaciones.

## Review

Revisión final: pass, con 0 Blocking y 0 Important; quedan dos observaciones Minor documentadas.

---

## Iteración 2 — Directorios y rediseño

### Fase 5 — Directorios y migración v2

- [x] Añadir `directoryPath` y migración v2 sin pérdida de datos.
- [x] Implementar exploración confinada e idempotencia por ruta.
- [x] Verificar bases nuevas, upgrade v1, traversal y symlinks.

### Fase 6 — Web y agentes

- [x] Mover el alta a una página dedicada con explorador.
- [x] Añadir browse/register project y update finding al MCP.
- [x] Actualizar skill y documentación con el flujo completo para agentes.

### Fase 7 — Rediseño visual

- [x] Sustituir el lenguaje de cuaderno por interfaz profesional neutra.
- [x] Verificar navegación, formularios, estados vacíos y responsive.

### Fase 8 — Demo y revisión

- [x] Ejecutar suite, typecheck, build, skill y Compose.
- [x] Verificar directorio y herramientas con cliente MCP real en `arturo-dev`.
- [x] Hacer QA visual por túnel y revisar el diff de forma independiente.
- [x] Dejar cambios staged, sin commit ni push.

Revisión iteración 2: pass, con 0 Blocking y 0 Important.
