# Security Inbox

Bandeja compartida para apuntar fallos de cualquier tipo por proyecto: funcionales, de
interfaz, calidad o seguridad. Los agentes pueden guardar lo que encuentran
mientras hacen otra tarea y retomarlo cuando se les pida. Una anotación queda
sin revisar; guardarla no inicia una investigación ni una corrección. Web y MCP
usan el mismo servicio y la misma base SQLite. Cada proyecto pertenece a un
usuario, que sirve para atribuir trabajo y no para restringir el acceso.

## Plataforma central

La instalación de casa está en **[arturo-dev](http://192.168.0.130:3300)** y guarda
los datos en `/root/Proyectos/security-inbox/data/security-inbox.sqlite`.
Los agentes conectan al MCP por SSH; no hace falta ejecutar esta aplicación ni
mantener SQLite en su equipo. Pueden registrar su workspace local con
`register_project({ directoryPath: "/ruta/absoluta", external: true })`, aunque
la carpeta no exista en el servidor. El selector web muestra carpetas del servidor.

La conexión, la skill y las instrucciones para agentes están en
[docs/mcp-and-skill.md](docs/mcp-and-skill.md); la operación del servidor, en
[docs/deployment.md](docs/deployment.md). La configuración central atribuye al
usuario existente `thebrokencat`. El acceso web requiere la red de casa o su VPN.

## Apuntar ahora y retomar después

Solo hacen falta **título y contexto**. Por ejemplo: «Al guardar el perfil con el
teclado, el foco vuelve al inicio; observado en `src/profile.ts:12`». Archivo,
línea y commit se añaden cuando se conocen. Gravedad, evidencia, origen y
recomendación son opcionales: la gravedad empieza en **Sin clasificar**, sin
asignar un riesgo arbitrario. El agente registra la observación y continúa su
tarea actual; la investigación y la corrección dependen de una petición posterior.

Web y MCP permiten recuperar toda la bandeja por páginas. `list_findings`
conserva el array `findings` y devuelve `total`, `limit`, `offset` y `nextOffset`;
pasa este último como `offset`, manteniendo los filtros, hasta recibir `null`.
Recoge las páginas antes de modificar incidencias, porque una edición puede
cambiar el orden. La búsqueda incluye texto, archivo y commit.

El historial registra el usuario de cada creación, edición, cambio de estado o
nota. La web lo obtiene de `si_user` y MCP de `SECURITY_INBOX_USER`. El autor se
conserva aunque se elimine después el usuario. `origin` es un dato independiente
para indicar, por ejemplo, qué agente detectó el fallo; si se omite, los
adaptadores usan `web` o `mcp`. Una identidad sin configurar aparece sin autor;
esto sigue siendo atribución, no autorización.

Al validar un formulario, la web conserva el borrador y señala los campos que
hay que corregir. Los cierres siguen exigiendo una nota con la comprobación.
La migración al esquema 4 es automática y conserva UUID, claves de reintento y
el historial anterior; sus autores aparecen como desconocidos.

## Requisitos e instalación

- Node.js 24 (la imagen usa `node:24-bookworm`).
- npm y, para el flujo Docker, Docker Compose v2 o posterior.

Con Node local:

```sh
nvm install 24
nvm use 24
npm ci
```

La base por defecto es `data/security-inbox.sqlite`. Se puede cambiar con
`SECURITY_INBOX_DB`.

La web registra proyectos seleccionando carpetas. En ejecución nativa puedes
navegar desde tu carpeta personal, subir de nivel o introducir una ruta completa
y seleccionar cualquier carpeta a la que tenga acceso el proceso. No necesitas
colocar los proyectos bajo `security-inbox` ni bajo una carpeta de proyectos fija.
Si se configura expresamente `SECURITY_INBOX_PROJECTS_ROOT`, limita el árbol
accesible; Docker mantiene ese límite sobre los directorios montados.

## Usuarios

Cada proyecto tiene un usuario dueño. **No hay inicio de sesión y esto no es
control de acceso**: la web guarda tu elección en la cookie `si_user`, cambiar de
usuario es un clic y nadie verifica nada. Security Inbox confía en la red por la
que llegas — está pensado para un homelab detrás de VPN, sin exposición externa.
Quien pueda abrir la web puede ponerse cualquier nombre.

Lo que sí aporta: separa tus proyectos de los del resto, atribuye los cambios de
cada agente configurado y evita que dos personas se pisen el listado.

- La primera visita muestra **¿Quién eres?** y permite crear el primer usuario.
- El identificador (`slug`) admite minúsculas, números y guiones.
- La lista de proyectos abre en **Míos** y el conmutador **Todos** enseña el
  inventario completo con la etiqueta de su dueño.
- Todos los proyectos aparecen en una sola cuadrícula, ordenados por su última
  actividad o la de cualquiera de sus hallazgos. El borde de cada tarjeta marca
  la peor gravedad abierta: crítica en negro, alta en rojo y el resto en su color
  habitual; los chips mantienen el significado también en texto.
- `/users` lista quién puede figurar como dueño. Un proyecto se traspasa desde su
  propia página, y un usuario solo se elimina cuando ya no tiene proyectos: el
  dueño es obligatorio en la base y nunca puede quedar apuntando a nadie.
- Los agentes MCP declaran su identidad en `SECURITY_INBOX_USER`. Sin esa
  variable pueden leer (`list_projects` con `scope: "all"`, `list_users`) pero
  `register_project` falla con `USER_REQUIRED` en vez de crear un proyecto
  huérfano.

Si actualizas una base creada antes del esquema 3, define
`SECURITY_INBOX_DEFAULT_USER` con el slug que hereda los proyectos existentes;
la migración crea ese usuario y se los asigna. Sobre una base vacía no hace
falta.

## Comandos locales

```sh
npm run seed          # dos proyectos y seis hallazgos sintéticos, idempotente
npm run demo          # seed + alta/retry/transición/historial/reapertura
npm test
npm run typecheck
npm run build
npm run web
```

`npm run web` escucha en loopback en ejecución nativa. El seed no inventa
personas: asigna sus proyectos a `SECURITY_INBOX_USER`, en su defecto al primer
usuario registrado, y solo crea el usuario `demo` si la base está vacía. Cubre
las cinco gravedades clasificadas y los cinco estados, conserva los UUID y no duplica eventos al
repetirse.
`npm run demo` añade un hallazgo sintético de recorrido y comprueba que el retry
con `demo-route-fixed-key` devuelve el mismo UUID.

## Docker Compose

La imagen compila con `npm ci` en `node:24-bookworm` y ejecuta como el usuario no
privilegiado `node`. `./data` se monta con escritura; la raíz de proyectos se
monta read-only en `/projects`. Compose crea el bridge propio del proyecto y la
web publica loopback del host por defecto; `SECURITY_INBOX_WEB_BIND` permite una IP explícita y `SECURITY_INBOX_WEB_ORIGIN` declara el origen permitido.

```sh
mkdir -p data
# En Linux, si data o un SQLite existente pertenecen a otro usuario:
# chown -R 1000:1000 data
docker compose build app
docker compose run --rm -T app
SECURITY_INBOX_USER=guzman docker compose up -d web
curl --fail http://127.0.0.1:3300/
docker compose ps
```

`SECURITY_INBOX_USER` es obligatoria la primera vez que se arranca sobre una
base creada antes del esquema 3: sin ella la migración se detiene en lugar de
inventar un dueño para los proyectos existentes.

La raíz Docker predeterminada es `/root/Proyectos`. Para otro host:

```sh
SECURITY_INBOX_PROJECTS_HOST_ROOT=/ruta/absoluta/Proyectos \
  SECURITY_INBOX_USER=guzman docker compose up -d web
```

Para probar MCP por stdio, conserva `-T` para no asignar un pseudo-terminal:

```sh
docker compose run --rm -T mcp
```

El proceso web recibe `SECURITY_INBOX_CONTAINER=true` y escucha dentro del
contenedor en `0.0.0.0:3300`; el host publica `127.0.0.1:3300` por defecto y la instalación central publica `192.168.0.130:3300`. La guía de
configuración MCP y skill está en [docs/mcp-and-skill.md](docs/mcp-and-skill.md).

Para repetir el recorrido completo de forma segura:

```sh
./scripts/verify-demo.sh
```

El script construye solo `app`, ejecuta la suite dentro de la imagen, siembra
datos, comprueba la web en loopback, cierra stdin del MCP, verifica stdout sin
banners y repite `npm run demo` antes y después de reiniciar `web`. Hace cleanup
de contenedores y red, pero conserva `./data`.

## Flujo operativo completo

1. Arranca `web`, elige quién eres (o crea el usuario), pulsa **Añadir proyecto**
   y selecciona una carpeta; el nombre y la ubicación se registran
   automáticamente y el proyecto queda a tu nombre.
2. Un agente comienza con `list_projects`, que por defecto solo devuelve los
   proyectos de `SECURITY_INBOX_USER`. Si falta la carpeta, usa
   `register_project` con su `directoryPath` completo y `external: true` cuando
   está en su propio equipo. Para carpetas montadas puede navegar y registrar
   normalmente; después conserva el UUID.
3. Lista hallazgos, comprueba candidatos parecidos y
   registra título y contexto con una clave de idempotencia estable. Los detalles
   pueden completarse después.
4. Repite la misma petición: debe devolver el mismo UUID y no crear otra fila.
5. Usa `update_finding`, cambia el estado con una nota cuando corresponda y
   consulta el detalle para comprobar el historial append-only.
6. Reinicia `web` y vuelve a conectar MCP; el UUID y los eventos deben seguir en
   `./data`.

La instalación central se abre directamente en `http://192.168.0.130:3300`.
Para una instalación que publique solo loopback, el túnel opcional es:

```sh
ssh -N -L 3300:127.0.0.1:3300 arturo-dev
```

El destino operativo previsto es `arturo-dev:/root/Proyectos/security-inbox`.

## Limitaciones verificadas

- No incluye autenticación ni despliegue público. El usuario es atribución, no
  control de acceso: la cookie es editable y nadie comprueba identidades.
- Las incidencias no tienen dueño propio; cuelgan del proyecto. El historial
  atribuye cada cambio al usuario configurado y `origin` permite describir la fuente.
- Las entradas son observaciones pendientes de revisar. La plataforma no inicia
  detección externa ni correcciones por sí sola.
- MCP se sirve por stdio y requiere un cliente configurado; `-T` es necesario
  en Compose para mantener stdout reservado al protocolo.
- Solo se documenta Node 24, Docker Compose v2 o posterior y el flujo remoto indicado; no se
  afirma compatibilidad con otros hosts.
- No se incluyen secretos ni credenciales en fixtures, imagen, Compose o docs.
- No se siguen symlinks que salgan de la raíz configurada y la web nunca lee el
  contenido de los archivos del proyecto.
- La interfaz reserva la escala rojo-naranja-verde para la gravedad; el color de
  usuario usa tonos aparte para que un dueño nunca se lea como un riesgo.
- Los iconos son SVG en línea, sin fuentes ni sprites: la CSP es `img-src 'self'`
  y cualquier recurso externo fallaría en silencio. Son decorativos y el texto
  que acompañan siempre lleva el significado.
- El borrado se limita a usuarios sin proyectos. No hay borrado de proyectos ni
  de hallazgos.

Para apagar el stack: `docker compose down`. La eliminación de `./data` es una
acción separada y borra la persistencia local.
