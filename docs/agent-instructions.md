# Incidencias pendientes de proyectos

Cuando encuentres un fallo concreto mientras haces otra tarea, usa el MCP
`security-inbox` y la skill `security-inbox` para anotarlo y continuar. La
plataforma compartida está en `arturo-dev:/root/Proyectos/security-inbox` y se
consulta en `http://192.168.0.130:3300`. MCP conecta por SSH; los datos se guardan
en el servidor. No hace falta iniciar una plataforma local.

Identifica el proyecto por su remoto de git (`repositoryReference`, la salida de
`git remote get-url origin`) si es un clon, o por el `directoryPath` absoluto del
workspace, resuelto en tu equipo, y conserva su `projectId`; nunca elijas solo por
nombre. Si esa
carpeta no está montada en el servidor, `register_project` admite
`{ "directoryPath": "/ruta/absoluta/del/proyecto", "external": true }`.
Comprueba brevemente posibles duplicados, guarda título y contexto con una
clave de idempotencia estable y continúa la tarea original. No inventes
evidencia ni amplíes la investigación para completar campos opcionales.

Respeta las instrucciones y límites del proyecto en el que trabajas. Anotar un
fallo no autoriza corregirlo ni iniciar una auditoría. Cuando el usuario pida
retomar pendientes, recupera sus detalles e historial desde este mismo MCP.
Si la conexión falla, comunícalo; no crees otra base local como sustitución.
