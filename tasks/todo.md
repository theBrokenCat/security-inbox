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

---

## Iteración 3 — Cuadrícula única por actividad

### Fase 9 — Modelo y presentación

- [x] Calcular `lastActivityAt` y ordenar todos los proyectos por actividad reciente.
- [x] Exponer el mismo dato y orden a la web y al MCP.
- [x] Sustituir la cola urgente por una sola cuadrícula de tarjetas.
- [x] Mostrar crítica en negro, alta en rojo y gravedad también mediante texto.
- [x] Actualizar documentación e instrucciones duraderas.
- [x] Ejecutar suite, typecheck, build y QA visual sobre datos aislados.
- [x] Dejar cambios staged, sin commit ni push.

---

## Iteración 4 — Bandeja de incidencias para agentes

- [x] Admitir fallos de cualquier tipo y actualizar textos, documentación y skill.
- [x] Permitir captura con título y contexto, sin exigir gravedad ni evidencia.
- [x] Paginar web y MCP, mantener filtros y buscar también por archivo y commit.
- [x] Registrar el autor de cada evento desde los adaptadores y conservar su atribución.
- [x] Mantener los borradores al corregir errores de los formularios.
- [x] Migrar al esquema v4 conservando datos, historial e idempotencia; verificar rollback.
- [x] Verificar con Node 24: 108 pruebas, typecheck, build, seed y demo aislados.
- [x] Validar la skill, revisar el diff y comprobar la interfaz en escritorio y móvil.

La captura guarda una observación y permite continuar la tarea actual. La revisión
y la corrección se retoman cuando el usuario las pide; no se lanzan agentes automáticamente.

---

## Iteración 5 — Selección libre de carpetas

- [x] Iniciar el selector nativo en la carpeta personal y permitir subir de nivel.
- [x] Añadir selección por ruta completa en web y MCP, conservando `relativePath`.
- [x] Mantener las rutas canónicas, el reintento por carpeta y los límites explícitos de despliegue.
- [x] Verificar carpetas fuera del directorio de arranque, symlinks, rutas no disponibles y montaje Docker.
- [x] Pasar 114 pruebas, typecheck, build y validación de skill con Node 24.
- [x] Activar la web sin raíz de proyectos predefinida y verificar el selector en Chrome.
