# Publicación inmediata del estado

## Flujo

El job `check` mide y crea el artefacto. `persist` guarda exclusivamente los dos
JSON en `status-data` y envía `{revision, status, incidents}` a `/data/publish`.
El publicador se ejecuta desde el commit protegido de `main` que inició el
workflow, nunca desde la rama de datos. Sólo `persist` recibe `id-token: write`.

El Worker verifica la firma RS256 con las claves HTTPS oficiales de GitHub,
audiencia, emisor, expiración, IDs de repo/organización, rama, workflow y evento.
Una publicación de otra rama, workflow, repo o PR se rechaza. No se guardan ni
registran tokens. El Durable Object `public-status-v1` guarda los dos documentos
en una transacción y rechaza mediciones anteriores o cambios a una medición ya
publicada. Un reintento idéntico es idempotente.

Las tres lecturas públicas responden `Cache-Control: no-store` y
`X-Status-Revision`. La página obtiene ambos JSON mediante una sola lectura a
`/data/snapshot.json` y refresca cada 15 segundos mientras está visible.
El publicador no considera terminado el trabajo hasta leer la misma versión
por esa URL pública. La frecuencia de medición sigue siendo cada 15 minutos.

## Preparación y despliegue

1. Verificar tests y revisión de Codex del PR. `STATUS_PUSH_ENABLED` debe estar
   ausente o en `false` durante la primera integración.
2. Respaldar en un directorio privado fuera de Git el código y la metadata del
   Worker productivo, sus bindings, vars, ID de versión y rutas. No imprimir
   secretos. Conservar también el SHA vigente de `status-data` y sus dos JSON.
3. Integrar el PR y publicar el Worker desde ese commit con `wrangler.toml`.
   La migración `v1-status-snapshot` crea la clase SQLite `StatusSnapshot`.
   No cambia la ruta existente `estado.sinergius.coop.ar/data/*`.
4. En ese primer despliegue, configurar `BOOTSTRAP_DATA_REVISION` con el SHA de
   40 caracteres vigente en `status-data`. Mientras el almacén está vacío se
   leen los JSON de ese commit inmutable, que evita el caché de rama de Raw.
   Ese respaldo debe tener menos de dos horas. No es un fallback para fallas
   del almacén ni para una medición vencida después de su inicialización.
5. Comprobar página/JSON 200 y POST sin identidad 401. Activar la variable del
   repo `STATUS_PUSH_ENABLED=true` y disparar `check-status.yml` en `main`.
6. Confirmar `check` y `persist` exitosos y que el publicador verificó la URL
   pública inmediatamente tras el POST. Repetir una segunda medición: ambas
   deben incrementar el historial, y cada lectura pública debe tener el nuevo
   `checkedAt` y `X-Status-Revision`. Registrar los tiempos medidos y la versión
   efectiva de Cloudflare. No simular una caída falsa en el historial público.

Después de inicializar el almacén, GitHub Raw no participa en las lecturas.
Los datos persisten al reiniciar o desplegar otra versión del Worker. El cliente
tolera un Worker anterior únicamente si `/data/snapshot.json` devuelve 404;
un 503 produce estado desconocido y no se reemplaza por datos anteriores.

## Fallas y rollback

Una falla al publicar deja el workflow en rojo. El commit de Git se conserva;
disparar una nueva medición desde `main` después de resolver el problema.
Una identidad inválida, cuerpo inválido o publicación anterior no cambia el
almacén. El estado guardado deja de servirse al superar dos horas.

Para volver al Worker anterior: desactivar `STATUS_PUSH_ENABLED`, restaurar la
versión/código anterior conservado y comprobar los endpoints individuales y la
página. Esto recupera la latencia de Raw y debe informarse como degradación.
No borrar ni renombrar la clase o su namespace al revertir: conservar el snapshot
para el siguiente despliegue. Si se revierte el frontend, los endpoints
individuales siguen funcionando con el Worker nuevo.

La operación no requiere cambios ni reinicios en la VPS.
