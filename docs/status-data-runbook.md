# Estado mutable fuera de `main`

La publicación actual por snapshot, el despliegue de Cloudflare y su rollback se
describen en [snapshot-rollout.md](snapshot-rollout.md). El resto de este archivo
conserva el procedimiento y la evidencia de la separación inicial de ramas.

## Motivo

`main` exige los controles `validate`, `Analyze (javascript-typescript)` y
`Analyze (actions)`. El monitor creaba un commit y hacía `git push` directo a
esa rama, por lo que GitHub lo rechazaba antes del despliegue de Pages. Una
interrupción real podía quedar publicada como operativa.

La rama `status-data` conserva exclusivamente:

- `data/status.json`;
- `data/incidents.json`.

El workflow siempre se ejecuta desde el código protegido de `main`. Sólo lee y
persiste esos dos archivos desde `status-data`, incluso si el estado general no
cambia: el historial no puede perder controles entre corridas. Nunca se carga
ni ejecuta código desde la rama de datos.

La web estática permanece en GitHub Pages. La ruta Cloudflare
`estado.sinergius.coop.ar/data/*` está limitada a esos dos nombres y obtiene su
contenido de `status-data`. El Worker rechaza redirecciones, cuerpos grandes,
JSON con esquema inesperado y estados con más de dos horas; ante cualquier
error responde 503 sin publicar diagnósticos internos.

## Evidencia previa y respaldo

Antes del cambio:

- `main`: `fcff51846beaf92245f1cd787890310bbf28ea78`;
- `data/status.json` SHA-256:
  `8938AE4B04A01A68F62ABB329385A289C9350AA9362B25341012A2C0EA1DA7FB`;
- `data/incidents.json` SHA-256:
  `07D914CA62187D8FADB0517944BF5D8F3532A22EDD3AC4D18846C691844FF415`;
- última corrida fallida observada: `31928580100`;
- el monitor midió `partial_outage`, pero el push fue rechazado con `GH006`;
- el respaldo del cambio Cloudflare del hostname de Estado está en
  `/var/backups/sinergius-cloudflare/estado-pre-proxy-20260816T051728Z`.

La creación de `status-data` debe partir de los dos JSON vigentes y su primer
commit `216ae28260075028c36c084857d2cfe3692c404a` queda como punto de
restauración. La protección de esa rama debe impedir
force-push y borrado, sin conceder bypass sobre `main`.

## Validación de una publicación

1. Confirmar que `check` mide los cuatro destinos y sube `monitor-state`.
2. Confirmar que `persist` parte de la corrida actual y no de otro artefacto.
3. Revisar que el commit de `status-data` modifica exactamente los dos JSON.
4. Ejecutar dos mediciones consecutivas y comprobar que cada una incrementa el
   contador, mientras continúa el mismo incidente sin crear uno duplicado.
5. Confirmar con una recuperación controlada que el incidente se resuelve sin
   crear otro y el contador vuelve a incrementarse.
6. Validar `https://estado.sinergius.coop.ar/data/status.json`, los assets y los
   encabezados de seguridad. `checkedAt` debe coincidir con `status-data` y una
   ruta fuera de los dos JSON debe seguir llegando a Pages o responder 404.

No se envían correos durante estas pruebas. El endpoint de reuniones es un
healthcheck autenticado y no destructivo.

## Rollback

Si la rama de datos no puede leerse o persistirse:

1. deshabilitar temporalmente el schedule/disparador del workflow defectuoso;
2. revertir el commit de `main` que introdujo `status-data` mediante PR y sus
   controles obligatorios;
3. quitar la ruta del Worker para volver temporalmente al último JSON estático
   de Pages;
4. conservar `status-data` para análisis; no borrarla ni forzar su historial;
5. si el problema fuese el proxy y no el workflow, usar el respaldo Cloudflare
   indicado arriba y validar nuevamente HTTPS, assets y JSON.

El rollback no requiere tocar SMTP, MailerSend ni DNS de Ugarte.
