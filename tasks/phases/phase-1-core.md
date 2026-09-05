# Fase 1: núcleo y persistencia

**Owner:** implementer — dominio backend/storage
**Write scope:** `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `src/core/**`, `src/storage/**`, `test/core/**`
**Excludes:** web, MCP, Docker, README, skill.

## Contrato congelado

`SecurityInboxService` expondrá exactamente los tipos y firmas completos del
diseño para `createProject`, `listProjects`,
`registerFinding`, `listFindings`, `getFinding`, `updateFinding`,
`updateFindingStatus`, `addFindingNote` y `findPossibleDuplicates`.

Los DTOs, límites, campos editables y errores son los definidos en el diseño.
La clave idempotente MCP será obligatoria; el alta web generará una y la enviará
en campo oculto para que un retry del navegador conserve la misma clave.

## Pasos TDD

1. Crear el manifiesto Node `>=24 <25` con versiones exactas: Fastify 5.12.3,
   `@fastify/formbody` 9.0.0, Nunjucks 3.2.4, better-sqlite3 13.0.3, Zod 4.5.4,
   MCP server/client 2.0.0, TypeScript 7.0.2, tsx 4.23.13 y Vitest 5.0.0;
   añadir scripts `test`, `typecheck`,
   `build`, `web`, `mcp`, `seed` y `demo`.
2. Escribir `test/core/validation.test.ts` y confirmar que falla por API ausente.
3. Implementar esquemas Zod mínimos y confirmar GREEN.
4. Escribir `test/core/service.test.ts` con base temporal: todos los campos,
   UUID estable, recuentos no terminales por gravedad, estado inicial,
   aislamiento, filtros, detalle, campos editables, notas y requisito atómico de
   nota al cerrar; confirmar RED.
5. Crear migración y repositorio SQLite con FK, CHECK, UNIQUE, WAL y timeout.
6. Implementar el servicio dentro de transacciones y confirmar GREEN.
7. Añadir RED para retry idéntico, conflicto de payload y dos conexiones
   concurrentes con la misma clave; implementar fingerprint/`BEGIN IMMEDIATE` y
   confirmar un ID, una fila, `created: true` una vez y `false` en el retry.
8. Añadir caso RED para candidatos parecidos sin auto-fusión; implementar
   normalización y solapamiento de tokens de forma acotada y confirmar GREEN.
9. Añadir RED que cierre y reabra el archivo SQLite y conserve datos/eventos.
10. Ejecutar `npm test -- test/core`, `npm run typecheck` y `npm run build`.

## Gate

No empieza la Fase 2 hasta que el lead verifique tests y diff, y publique a los
writers las firmas finales del servicio. Sin commit.
