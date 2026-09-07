# Cuadrícula única de proyectos

Fecha: 2026-09-07
Estado: aprobado para implementación

## Problema

La portada separa los proyectos con hallazgos críticos o altos en una cola
especial y deja el resto en tarjetas. Ese cambio de formato rompe la lectura del
inventario como un conjunto y hace que la posición dependa de la gravedad en
lugar de la actividad reciente.

## Decisiones

### 1. Una sola cuadrícula

Todos los proyectos usan la misma tarjeta y viven en una única cuadrícula. No
hay secciones *Requiere atención ahora* ni *Resto de proyectos*.

La peor gravedad abierta sigue siendo visible mediante el borde y una etiqueta
de texto. El texto evita que el significado dependa solo del color.

### 2. Color de la tarjeta

- crítica: negro;
- alta: rojo;
- media, baja, informativa y sin hallazgos: conservan el sistema actual.

El cambio afecta al acento de la tarjeta. La barra interna continúa mostrando la
distribución completa de hallazgos con la paleta existente.

### 3. Orden por última actividad

`lastActivityAt` es la fecha más reciente entre `projects.updated_at` y el
`updated_at` de cualquiera de sus hallazgos. Registrar, editar, anotar o cambiar
el estado de un hallazgo lo actualiza; crear o traspasar el proyecto actualiza la
fecha del propio proyecto.

La lista se ordena por `lastActivityAt` descendente. Los empates se resuelven por
nombre sin distinguir mayúsculas y, finalmente, por UUID para que el resultado
sea determinista.

`lastActivityAt` forma parte de `ProjectSummary` y de la salida MCP de
`list_projects`, para que la web y los agentes compartan exactamente el mismo
criterio.

## Alcance descartado

- No se añade JavaScript ni una preferencia de orden configurable.
- No se cambia la gravedad de cada hallazgo ni la barra de distribución.
- No se migra ni modifica la base de datos: la fecha se deriva en la consulta.
- No se tocan los datos reales; la demo usa la base aislada existente.
