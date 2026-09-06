# Fase 8: demo y revisión

**Files:**
- Modify: `compose.yaml`, `Dockerfile`, `README.md`, `AGENTS.md`
- Modify: `scripts/verify-demo.sh`, `test/demo/docker.test.ts`

## Pasos

1. Montar `${SECURITY_INBOX_PROJECTS_HOST_ROOT:-/root/Proyectos}` read-only en
   `/projects`; configurar roots access/display.
2. Añadir tests de Compose, imagen y variables sin exponer otro puerto.
3. Ejecutar `npm test`, typecheck, build, demo, skill, Compose y diff-check.
4. En `arturo-dev`, comprobar upgrade real, directorio read-only, web healthy y
   persistencia.
5. Con cliente MCP oficial, navegar, registrar proyecto y editar un hallazgo.
6. Hacer QA visual por túnel y revisión independiente con 0 Blocking/Important.
7. Preparar únicamente cambios propios con `git add`; no commit ni push.
