# Lecciones

- La imagen debe usar `node:24-bookworm`, no `node:24-slim`: la compilación
  nativa de `better-sqlite3` necesita Python, make y g++ en el host objetivo.
- El baseline remoto operativo previsto es
  `arturo-dev:/root/Proyectos/security-inbox`; esa ruta no constituye por sí
  sola evidencia de despliegue ni de ejecución remota.
- Los fixtures demo se identifican por `repositoryReference` sintético estable,
  no solo por nombre: un proyecto real homónimo debe conservarse separado.
- Docker debe copiar `views` y `public`, construir la imagen solo en `app` y
  ejecutar MCP directamente desde `dist/src/mcp/server.js`; el código y las
  dependencias permanecen root-owned y solo `/app/data` es escribible por
  `node`.
- Una red Compose marcada `internal` no publica el puerto web en `arturo-dev`;
  usa el bridge propio por defecto y restringe la publicación del host a
  `127.0.0.1`.
- En Linux, corrige recursivamente `./data` a UID/GID 1000 antes de ejecutar los
  contenedores. Cambiar solo la carpeta no arregla un archivo SQLite heredado
  `root:root`: las lecturas pasan, pero una nueva escritura falla.
- El alta de proyectos no pertenece a la portada: usa una página dedicada que
  seleccione una carpeta, derive el nombre y conserve `directoryPath`.
- La UI acordada es profesional neutra: sans-serif, sin metáforas de papel ni
  serif, y sin color decorativo. **Superada el 2026-09-06 en la parte cromática**
  (ver L003): el color pasa a tener función y se admite paleta viva, pero siguen
  vigentes el sans-serif, la ausencia de metáforas de papel y la prohibición de
  color puramente decorativo.

---

> A partir de aquí, plantilla fija (`~/z_dev/scaffolding/templates/lessons.md`).
> Las entradas anteriores son del formato antiguo y se conservan como estaban.

## L001 — Reconstruir una tabla referenciada en SQLite · 2026-09-06
- **Contexto**: migración v3, añadir `projects.owner_id NOT NULL REFERENCES users(id)`.
- **Síntoma**: primero `FOREIGN KEY constraint failed` en el COMMIT pese a que
  `foreign_key_check` devolvía vacío; después `no such table: main.projects_legacy`
  al insertar hallazgos.
- **Causa**: dos comportamientos distintos, ambos verificados con una sonda y no
  deducidos. (1) `DROP TABLE` sobre una tabla referenciada incrementa el contador
  de violaciones diferidas y nada lo decrementa, así que el COMMIT falla aunque los
  datos sean consistentes. (2) `legacy_alter_table` solo impide que
  `ALTER TABLE RENAME` reescriba las claves foráneas de otras tablas si
  `foreign_keys` está OFF — y better-sqlite3 las activa en cada conexión.
- **Decisión/Fix**: migrar con `foreign_keys = OFF` (se activan al terminar),
  renombrar la tabla vieja **antes** de crear la nueva y borrarla cuando ya nadie
  la referencia, y demostrar la integridad con `foreign_key_check` tras el commit.
- **Regla**: ante un comportamiento de SQLite que condiciona el diseño, escribe
  una sonda de cuatro líneas y mídelo antes de elegir el orden de la migración.
- **Aplica en**: storage, sqlite, migraciones, better-sqlite3
- **Promocionar**: no — es específico de SQLite y ya vive en `AGENTS.md`.

## L002 — El perfil de trabajo lo marca el usuario, no el skill · 2026-09-06
- **Contexto**: tras aprobar el diseño de proyectos por usuario, el skill
  `brainstorming` terminaba invocando `writing-plans`.
- **Síntoma**: el usuario cortó con «no crees el plan. implementa todo sin
  pararte».
- **Causa**: seguí el estado terminal del skill como si fuera obligatorio, cuando
  el usuario ya tenía el diseño aprobado y quería ejecución directa.
- **Decisión/Fix**: implementar del tirón, conservando las verificaciones
  (tests, typecheck, navegador) pero sin plan intermedio ni gates por tarea.
- **Regla**: el estado terminal de un skill de proceso cede ante una instrucción
  explícita del usuario sobre el ritmo; conserva las verificaciones, no la
  ceremonia.
- **Aplica en**: proceso, skills, brainstorming, writing-plans
- **Promocionar**: sí, regla global — vale para cualquier proyecto, no solo este.

## L003 — El color con función supera al color neutro · 2026-09-06
- **Contexto**: rediseño pedido por el usuario, «una interfaz más atractiva y
  colorida», sobre una app donde el color ya era señal de gravedad.
- **Síntoma**: la lección anterior prohibía «color decorativo dominante», lo que
  leído literalmente bloqueaba cualquier paleta viva.
- **Causa**: la lección mezclaba dos cosas distintas — prohibir adorno (sigue
  siendo válido) y prohibir color (nunca fue el objetivo).
- **Decisión/Fix**: la gravedad conserva **en exclusiva** la escala
  rojo-naranja-verde en tres pesos; los acentos de usuario viven en una familia
  cromática aparte; los estados llevan forma además de color. Los guardarraíles
  mecánicos (`rotate(`, gradientes repetidos, `Georgia`) siguen intactos y se
  respetaron rehaciendo las formas con bordes.
- **Regla**: antes de añadir color a una interfaz, comprueba qué significa ya el
  color en ella; si una escala tiene dueño, lo nuevo va en otra familia cromática.
- **Aplica en**: frontend, css, diseño, accesibilidad
- **Promocionar**: no — depende de que esta app use el color como señal.

## L004 — Un inventario conserva una sola geometría · 2026-09-07
- **Contexto**: portada de proyectos con una cola lineal para crítico/alto y una
  cuadrícula distinta para el resto.
- **Síntoma**: el usuario no podía recorrer los proyectos como un solo inventario;
  la gravedad cambiaba tanto el formato como el orden.
- **Causa**: se convirtió la prioridad en una estructura de navegación cuando el
  usuario solo necesitaba una señal visual dentro de cada proyecto.
- **Decisión/Fix**: una única cuadrícula ordenada por la actividad más reciente;
  el borde de la tarjeta comunica gravedad (crítica negro, alta rojo) y los chips
  conservan la etiqueta textual.
- **Regla**: si todos los elementos son la misma entidad navegable, conserva una
  geometría común y expresa el estado dentro del componente; solo crea otra cola
  cuando haya un flujo operativo distinto confirmado.
- **Aplica en**: frontend, navegación, priorización, accesibilidad
- **Promocionar**: no — es una decisión de producto específica de esta portada.
