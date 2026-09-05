# Fase 4: revisión y entrega

## Revisión

- Spec reviewer: cobertura literal del alcance y ausencia de extras.
- Quality reviewer: dominio, SQL, concurrencia/idempotencia, límites de entrada,
  XSS, CSRF/origen, bind loopback, stdio, tests y mantenibilidad.
- Un inventario completo por snapshot y como máximo dos lotes de corrección.

## Verificación final

Ejecutar sobre `arturo-dev` y el mismo snapshot:

```bash
docker compose run --rm app npm test
docker compose run --rm app npm run typecheck
docker compose run --rm app npm run build
docker compose run --rm app npm run demo
rg -n '(sk-proj-|ghp_|AKIA|BEGIN (RSA|OPENSSH) PRIVATE KEY)' . \
  --glob '!node_modules/**' --glob '!dist/**' --glob '!package-lock.json' \
  --glob '!test/demo/no-secrets.test.ts' --glob '!tasks/phases/phase-4-review.md'
git diff --check
git status --short --branch
```

La búsqueda de secretos debe no encontrar patrones. Después preparar solo
cambios propios con `git add -- <paths>` y mostrar `git diff --cached --stat` y
`git diff --cached --check`. No commit ni push.

## Informe final

Indicar qué funciona, comandos de arranque y recorrido, verificaciones frescas,
compatibilidad MCP realmente comprobada y limitaciones del borrador.
