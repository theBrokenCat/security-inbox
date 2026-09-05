# Fase 3: demo

## Demo observable

1. `docker compose build` termina con exit 0.
2. `docker compose run --rm app npm run seed` deja dos proyectos y seis hallazgos.
3. `docker compose up -d web` responde solo en `127.0.0.1:3300`.
4. El cliente MCP registra un hallazgo con clave fija y el retry devuelve el
   mismo ID sin aumentar el recuento.
5. La web muestra el hallazgo; el cambio a resuelto con nota aparece en historial.
6. Tras reiniciar web/MCP, el mismo ID y eventos siguen presentes.
7. La selección usa el UUID mostrado en la web/listado MCP y la búsqueda previa
   devuelve candidatos sin fusionarlos.
