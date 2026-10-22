# Estado de Sinergius

Página pública y neutral para comunicar la disponibilidad de Sinergius.
Está alojada fuera de la VPS productiva para que permanezca visible durante una
interrupción del servidor.

## Controles

El workflow `Verificar servicios` consulta la web institucional, el endpoint
no destructivo del formulario de reuniones y el dominio alternativo. Reintenta
antes de declarar una falla, actualiza los componentes
afectados y abre o resuelve automáticamente el incidente público. Cada control
publica la hora confirmada en la rama aislada `status-data`.
La página vuelve a consultar el estado publicado cada quince segundos mientras está visible y también cuando
el usuario regresa a una pestaña que había quedado abierta.

Cada componente muestra un gráfico compacto de los últimos 90 días. El historial
empieza con la primera medición real: los días anteriores se ven como no medidos
y no se completan con disponibilidad ficticia.

### Separación respecto de Delivery

Hasta el 11 de agosto de 2026 este repositorio controlaba `app.sanezeit.com`,
que corresponde a Delivery y no forma parte de Sinergius. El último estado y
todo el código anterior quedaron preservados en la etiqueta Git
`delivery-status-final-2026-08-11`. Esa etiqueta es el punto de partida para
crear más adelante el monitor independiente de Delivery.

El historial público de Sinergius comienza con la migración; no se mezclan
estadísticas ni incidentes de ambos productos.

### Una falla del control no es una caída del servicio

El control corre en una máquina alquilada a GitHub. Si esa máquina se queda sin
salida a internet, no puede consultar nada, y eso no dice nada sobre la
plataforma. Por eso, antes de publicar una caída se consulta un destino externo
ajeno al proyecto: si tampoco responde, el resultado se descarta y el estado
queda como estaba.

### El resumen diario cuenta controles

Cada día guarda cuántos controles hubo y cuántos fallaron. Antes se guardaba el
peor resultado del día, así que un control fallido de treinta pintaba la jornada
entera como caída total.

### Quién dispara los controles

El reloj de GitHub no alcanza. El workflow pide cuatro corridas por hora y
**GitHub entrega alrededor de una**: el evento `schedule` corre con baja
prioridad y se pospone, es un comportamiento conocido de Actions y no se puede
forzar desde el propio workflow. Se llegó a medir 34 controles el 30/07 y solo
6 el 06/08.

Por eso el disparo real viene de afuera, de una tarea en **cron-job.org** que
cada quince minutos llama a:

```
POST https://api.github.com/repos/Sinergius-coop-ar/estado-servicio/actions/workflows/check-status.yml/dispatches
Authorization: Bearer <token>
Accept: application/vnd.github+json
Content-Type: application/json

{"ref":"main"}
```

A diferencia de `schedule`, `workflow_dispatch` se atiende al instante: medido,
la corrida arranca dos segundos después del pedido. GitHub responde `204` sin
cuerpo.

El `schedule` del workflow queda activo como respaldo: si el disparador externo
falla, se sigue midiendo una vez por hora.

#### El token

Es un token *fine-grained* sin vencimiento, limitado a este repositorio y con el
único permiso `Actions: read and write`. Con ese alcance, quien lo obtenga solo
puede disparar este control: no lee código, no toca otros repositorios y no
publica nada.

Al no vencer, no hay una fecha que recordar, pero tampoco caduca solo si alguna
vez queda expuesto. Si eso pasa, se revoca desde
`github.com/settings/personal-access-tokens`, se genera otro con el mismo
alcance y se actualiza el encabezado en cron-job.org.

Si el disparo dejara de llegar por cualquier motivo, **nada se rompe de forma
visible**: la página sigue publicando y el `schedule` sigue midiendo una vez por
hora. La única señal es que el conteo diario de controles cae de unos 90 a unos
20.

## Desarrollo

No requiere dependencias externas.

```bash
npm run check
python -m http.server 8080
```

Abrir `http://localhost:8080`.

## Datos públicos

- `data/status.json`: estado general y por componente.
- `data/incidents.json`: incidentes de los últimos 90 días.

Los archivos no incluyen IP, versiones, credenciales, logs ni mensajes de error
internos.

## Publicación

`Publicar página de estado` valida y despliega el sitio estático mediante GitHub
Pages en `estado.sinergius.coop.ar`. El workflow programado conserva los dos
JSON después de cada medición válida. Después del commit, el monitor publica
ambos JSON juntos en el Worker `worker/status-snapshot.mjs`, autenticado con una
identidad OIDC temporal de GitHub Actions limitada a este repositorio, `main` y
el workflow del monitor. No necesita una contraseña de publicación permanente.
Un único Durable Object con SQLite conserva esa versión de forma atómica y
consistente; las lecturas públicas no consultan GitHub Raw ni usan caché HTTP.
El Worker valida esquema, tamaño y vigencia y responde 503 si el estado guardado
supera dos horas o el almacenamiento falla.

`/data/snapshot.json` entrega ambos documentos juntos a la página, evitando
mezclar mediciones durante una actualización. Los endpoints individuales
`/data/status.json` y `/data/incidents.json` siguen disponibles. El encabezado
`X-Status-Revision` identifica el commit de datos publicado.

El código y los workflows permanecen en `main`, con sus controles obligatorios.
Los dos JSON mutables se conservan en la rama `status-data`, que no es fuente de
código ni de GitHub Pages. GitHub Pages sólo se vuelve a desplegar cuando cambia
el código de `main`; cada medición publica los datos por la ruta aislada del Worker.
El procedimiento de operación y rollback está en
[`docs/status-data-runbook.md`](./docs/status-data-runbook.md).

GitHub Pages debe tener `estado.sinergius.coop.ar` como dominio personalizado y
DNS debe publicar un CNAME explícito hacia `sinergius-coop-ar.github.io`. El
wildcard general de la VPS no reemplaza ese registro.
