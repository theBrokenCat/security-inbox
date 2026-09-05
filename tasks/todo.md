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
