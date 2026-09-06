# Fase 6: web y paridad para agentes

**Files:**
- Modify: `src/web/app.ts`, `src/web/server.ts`, `views/*.njk`
- Create: `views/project-new.njk`
- Modify: `src/mcp/factory.ts`, `test/mcp/server.e2e.test.ts`
- Modify: `skills/security-inbox/SKILL.md`, `docs/mcp-and-skill.md`
- Test: `test/web/app.test.ts`, `test/web/server.test.ts`

## Pasos

1. RED web: portada sin formulario y enlace `Añadir proyecto`.
2. RED web: navegación de carpeta, breadcrumb, selección y nombre derivado.
3. Inyectar `ProjectDirectoryManager` en web y añadir GET `/projects/new` más
   POST `/projects/register` protegido por CSRF.
4. RED MCP: nueve tools, schemas y recorrido browse→register→update finding.
5. Registrar `browse_project_directories`, `register_project` y
   `update_finding` con validación/errores/outputSchema existentes.
6. Actualizar skill y guía sin añadir borrado ni afirmar clientes no probados.
7. Ejecutar tests web/MCP, typecheck, build y `quick_validate.py`.
