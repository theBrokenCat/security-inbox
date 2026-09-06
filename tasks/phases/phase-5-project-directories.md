# Fase 5: directorios y migración v2

**Files:**
- Modify: `src/core/types.ts`, `src/core/validation.ts`, `src/core/service.ts`
- Modify: `src/storage/database.ts`, `src/storage/repository.ts`
- Create: `src/projects/directory-manager.ts`
- Test: `test/core/service.test.ts`, `test/core/storage.test.ts`, `test/projects/directory-manager.test.ts`

## Pasos

1. Añadir tests RED: `Project.directoryPath`, upgrade v1→v2, path único y UUIDs
   conservados.
2. Implementar migración v2 incremental y mappings de repositorio.
3. Añadir tests RED de listado, orden, path traversal, raíz no seleccionable y
   symlink externo.
4. Implementar `ProjectDirectoryManager` con `realpath`, raíz confinada y
   mapping access/display.
5. Añadir RED de registro repetido y descripción omitida.
6. Implementar `registerProjectDirectory` atómico usando:

```ts
registerProjectDirectory(input: {
  name: string;
  description: string;
  directoryPath: string;
}): { project: Project; created: boolean }
```

7. Ejecutar `npm test -- test/core test/projects`, typecheck y build.

No commit: el cierre autorizado es diff staged para revisión.
