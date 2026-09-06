# Security Inbox — directorios y rediseño profesional

## Objetivo

Registrar proyectos seleccionando un directorio del host donde se ejecuta la
plataforma, eliminar el formulario de la portada y ofrecer paridad suficiente
para que un agente gestione proyectos y hallazgos sin depender de la web.

## Exploración de directorios

`ProjectDirectoryManager` será la única frontera compartida de filesystem.
Navega bajo una raíz accesible y traduce cada ruta relativa a una ruta visible
persistida:

```ts
type DirectoryEntry = {
  name: string;
  relativePath: string;
  displayPath: string;
};
type DirectoryListing = {
  rootDisplayPath: string;
  relativePath: string;
  displayPath: string;
  parentRelativePath: string | null;
  directories: DirectoryEntry[];
};
type RegisterProjectDirectoryInput = {
  relativePath: string;
  description?: string | null;
};
type RegisterProjectDirectoryResult = { project: Project; created: boolean };
```

- `SECURITY_INBOX_PROJECTS_ROOT` es la raíz accesible; por defecto `cwd`.
- `SECURITY_INBOX_PROJECTS_DISPLAY_ROOT` es la raíz que se guarda/muestra; por
  defecto coincide con la accesible.
- Solo se listan directorios. Rutas absolutas, `..`, NUL y escapes por symlink
  se rechazan; symlinks externos no se muestran.
- La raíz sirve para navegar, pero no se puede registrar como proyecto.
- El nombre se deriva de `basename`; la descripción es opcional y recibe un
  texto neutro derivado de la ruta cuando se omite.
- Registrar de nuevo la misma ruta real devuelve el proyecto existente con
  `created: false`.

En Docker, `/root/Proyectos` se monta read-only en `/projects`. La raíz accesible
es `/projects` y la visible `/root/Proyectos`; ambas se pueden sobrescribir con
variables de entorno para otro host.

## Persistencia

Migración v2 añade `projects.directory_path TEXT` y un índice único parcial para
valores no nulos. Los proyectos existentes y fixtures conservan `NULL`; todas
las lecturas devuelven `directoryPath: string | null`. No se altera ningún UUID.

## Web

- La portada solo lista proyectos y ofrece `Añadir proyecto` en la cabecera.
- `/projects/new` navega directorios con breadcrumb y lista de carpetas.
- El usuario selecciona la carpeta actual y puede añadir una descripción
  opcional. No escribe nombre ni ruta.
- Las rutas y errores conservan las defensas Host/Origin/CSRF existentes.

## MCP y agentes

Se añaden tres herramientas, para un total de nueve:

- `browse_project_directories`: navega la raíz y devuelve rutas relativas
  reutilizables.
- `register_project`: selecciona una ruta relativa y registra/idempotentiza el
  proyecto.
- `update_finding`: edita los campos permitidos de un hallazgo.

Las seis herramientas anteriores se conservan. La skill indica el flujo más
corto: listar proyectos, explorar/registrar solo si falta, buscar duplicados,
registrar sospecha y usar el ID estable para el resto.

## Dirección visual

Herramienta profesional neutra: fondo gris claro, superficies blancas, azul
marino y grises; sans-serif local; chips de gravedad contenidos. Se eliminan
textura de papel, línea roja, sellos inclinados, serif, titulares exagerados y
mayúsculas decorativas. La jerarquía será compacta, consistente y responsive.

## Aceptación

1. La portada no contiene campos de creación.
2. Se navega `/root/Proyectos`, se selecciona una carpeta y el nombre/ruta se
   registran sin escritura manual.
3. Traversal y symlinks fuera de raíz fallan sin revelar contenido.
4. Un agente completa registro de proyecto y CRUD permitido de hallazgos por MCP.
5. Una base v1 reabre como v2 sin perder UUIDs/historial.
6. Docker mantiene la raíz de proyectos read-only y la web solo en loopback.
7. Suite, cliente MCP real y QA visual pasan sobre el snapshot final.
