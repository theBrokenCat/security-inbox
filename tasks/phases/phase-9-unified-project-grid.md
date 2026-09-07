# Fase 9 — Cuadrícula única por actividad

## Objetivo

Mostrar todos los proyectos como tarjetas en una sola cuadrícula, con crítica en
negro, alta en rojo y orden compartido por la última actividad del proyecto o de
sus hallazgos.

## Plan de implementación

1. Añadir pruebas RED del cálculo y orden de `lastActivityAt`, incluidos empates.
2. Añadir pruebas RED de la única cuadrícula, etiquetas accesibles y colores.
3. Extender `ProjectSummary`, la consulta SQLite y el esquema MCP.
4. Eliminar la presentación urgente y reutilizar la tarjeta para todo proyecto.
5. Actualizar instrucciones y documentación que describían el orden anterior.
6. Ejecutar pruebas focalizadas y completas, typecheck, build y QA visual sobre
   la base de demo aislada.
7. Preparar únicamente este diff en staging para revisión; sin commit ni push.

## Evidencia de aceptación

- `listProjects` devuelve actividad descendente sin priorizar gravedad.
- Registrar, editar, anotar o cambiar el estado de un hallazgo mueve el proyecto
  al principio.
- La portada no contiene las dos secciones anteriores y renderiza una tarjeta
  por proyecto.
- Las tarjetas críticas usan negro y las altas rojo, ambas con texto de gravedad.
- La salida MCP incluye `lastActivityAt`.
- Suite, typecheck y build terminan en verde.
