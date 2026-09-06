# Proyectos por usuario e interfaz en color

Fecha: 2026-09-06
Estado: implementado

## Problema

Security Inbox era de una sola persona. Con varias personas y varios agentes
sobre la misma base, el listado de proyectos se mezcla y no hay forma de saber
quién registró qué. La instalación vive en un homelab detrás de VPN, sin
exposición externa, y no se quiere un inicio de sesión.

En paralelo, la interfaz usaba un solo tono por gravedad y resultaba plana: la
información de riesgo no saltaba a la vista.

## Decisiones

### 1. La identidad es atribución, no control de acceso

La web guarda el usuario elegido en la cookie `si_user`; el MCP lo lee de
`SECURITY_INBOX_USER`. Cambiar de usuario es un clic y nadie verifica nada.

Se descartó la cabecera de proxy inverso (exige un proxy que aquí no existe) y
la instancia por usuario (no permite ver quién tiene qué sin entrar en cada
una).

**Consecuencia asumida:** un aislamiento duro sería una cortina con aspecto de
muro. Por eso la vista por defecto es *Míos* con un conmutador *Todos*, y tanto
el README como la propia pantalla de selección dicen explícitamente que esto no
restringe el acceso.

### 2. La identidad se resuelve en el adaptador, nunca en el núcleo

`src/core` recibe un `ownerId` ya resuelto y no sabe nada de cookies ni de
variables de entorno, igual que hoy no resuelve rutas del filesystem — eso vive
en `directory-manager.ts`. La frontera se mantiene.

### 3. `owner_id` es NOT NULL, con backfill en la migración

Se eligió la tabla `users` con clave foránea para que no existan dueños
fantasma. Dejar `owner_id` nullable habría creado exactamente eso, y habría
obligado a construir una pantalla de reasignación para arreglar a mano lo que la
migración decidió no hacer.

Las bases con proyectos previos necesitan `SECURITY_INBOX_DEFAULT_USER`; sobre
una base vacía la migración no pide nada.

**Detalle de SQLite que costó encontrar:** no se puede añadir una columna
`NOT NULL` con `REFERENCES`, así que la tabla se reconstruye. Y la
reconstrucción solo funciona con `foreign_keys = OFF`: se comprobó
empíricamente que `legacy_alter_table` no impide que `ALTER TABLE RENAME`
reescriba la clave foránea de `findings` mientras las FK están activas. Además,
`DROP TABLE` sobre una tabla referenciada incrementa el contador de violaciones
diferidas y nada lo decrementa, así que la tabla vieja se renombra antes de
crear la nueva, y se borra cuando ya nadie la referencia. La integridad se
demuestra con `foreign_key_check` tras el commit.

### 4. El color tiene función

La gravedad conserva en exclusiva la escala rojo-naranja-verde, ahora en tres
pesos (`solid`, `soft`, `border`) en lugar de un tono plano. Se añade:

- borde izquierdo de la tarjeta = peor gravedad abierta del proyecto;
- barra de distribución proporcional de hallazgos abiertos;
- estados con **forma además de color**, para no depender solo del tono;
- acento por usuario en una familia cromática aparte, para que un dueño nunca se
  lea como un nivel de riesgo;
- modo claro y oscuro.

**Restricciones respetadas:** la CSP es `style-src 'self'`, así que no hay
`style` inline en ninguna vista — la anchura de la barra se calcula en el
servidor y viaja como clase de un conjunto cerrado de pasos del 5 %, y el color
de usuario viaja como clase validada por el `CHECK` de la tabla. Tampoco se
introduce JavaScript: el conmutador son enlaces y el selector un formulario.

Se mantuvo intacto el guardarraíl que prohíbe `rotate(`, gradientes repetidos y
`Georgia` en la hoja de estilos: las formas de estado y el indicador del menú se
construyen con bordes en lugar de rotaciones.

## Alcance descartado

- Dueño en los hallazgos: `origin` ya registra quién los reportó.
- Borrado de usuarios: el proyecto no implementa borrado en esta iteración.
- Fusión o traspaso de proyectos entre usuarios.
