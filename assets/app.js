const STATUS_LABELS = {
  operational: "Operativo",
  degraded: "Rendimiento degradado",
  partial_outage: "Interrupción parcial",
  major_outage: "Interrupción total",
  maintenance: "Mantenimiento",
  unknown: "Sin confirmar",
};

const OVERALL_TITLES = {
  operational: "Todo operativo.",
  degraded: "El servicio funciona con demoras.",
  partial_outage: "Hay una interrupción parcial.",
  major_outage: "El servicio está interrumpido.",
  maintenance: "Mantenimiento en curso.",
  unknown: "No pudimos confirmar el estado.",
};

const dateTimeFormatter = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "medium",
  timeStyle: "short",
});
const timeFormatter = new Intl.DateTimeFormat("es-AR", { timeStyle: "short" });
const shortDateFormatter = new Intl.DateTimeFormat("es-AR", {
  day: "numeric",
  month: "short",
});
const AUTO_REFRESH_MS = 15_000;
let renderInFlight = false;

function safeStatus(value) {
  return Object.hasOwn(STATUS_LABELS, value) ? value : "unknown";
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Horario sin confirmar" : dateTimeFormatter.format(date);
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "hora sin confirmar" : timeFormatter.format(date);
}

function componentRow(component) {
  const status = safeStatus(component.status);
  const article = document.createElement("article");
  article.className = "service-row";
  article.dataset.status = status;

  const node = document.createElement("span");
  node.className = "service-node";
  node.setAttribute("aria-hidden", "true");

  const copy = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = component.name;
  const description = document.createElement("p");
  description.textContent = component.description;
  copy.append(title, description);

  const label = document.createElement("span");
  label.className = "status-label";
  label.textContent = STATUS_LABELS[status];

  article.append(node, copy, label);
  return article;
}

function recentDays(checkedAt, count = 90) {
  const end = new Date(checkedAt);
  if (Number.isNaN(end.getTime())) {
    return [];
  }

  end.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(end);
    day.setUTCDate(end.getUTCDate() - (count - index - 1));
    return day.toISOString().slice(0, 10);
  });
}

// Misma regla que usa el control al cerrar el día: un control fallido entre
// muchos es una molestia, no una caída total.
function dayStatusFromCounts(checks, failedCount) {
  if (!checks || failedCount <= 0) {
    return "operational";
  }

  const ratio = failedCount / checks;

  if (ratio < 0.2) {
    return "degraded";
  }

  return ratio < 0.6 ? "partial_outage" : "major_outage";
}

function dayDetail(entry, componentId) {
  if (!entry) {
    return { status: "unknown", checks: 0, failed: 0 };
  }

  if (typeof entry.checks === "number") {
    const failed = entry.failed?.[componentId] ?? 0;
    return {
      status: dayStatusFromCounts(entry.checks, failed),
      checks: entry.checks,
      failed,
    };
  }

  // Días guardados con el formato anterior, que solo conservaba una etiqueta.
  const status = safeStatus(entry.components?.[componentId] ?? entry.overall);
  return { status, checks: 0, failed: 0 };
}

function componentHistory(component, statusData) {
  const historyByDay = new Map(
    (statusData.history?.days ?? []).map((entry) => [entry.date, entry]),
  );
  const days = recentDays(statusData.checkedAt);
  const details = days.map((date) => dayDetail(historyByDay.get(date), component.id));
  const measured = details.filter((detail) => detail.status !== "unknown");
  const totalChecks = measured.reduce((sum, detail) => sum + detail.checks, 0);
  const totalFailed = measured.reduce((sum, detail) => sum + detail.failed, 0);
  const percentage = totalChecks
    ? Math.round(((totalChecks - totalFailed) / totalChecks) * 1000) / 10
    : null;

  return { days, details, measuredDays: measured.length, totalChecks, percentage };
}

function dayTitle(date, detail) {
  if (detail.status === "unknown") {
    return `${date} · Sin medición`;
  }

  if (!detail.checks) {
    return `${date} · ${STATUS_LABELS[detail.status]}`;
  }

  const controles = detail.checks === 1 ? "1 control" : `${detail.checks} controles`;

  if (!detail.failed) {
    return `${date} · ${controles}, sin problemas`;
  }

  return `${date} · ${detail.failed} de ${controles} con problemas`;
}

function uptimeChart(component, statusData) {
  const history = componentHistory(component, statusData);
  const wrapper = document.createElement("div");
  wrapper.className = "uptime-chart";

  const bars = document.createElement("div");
  bars.className = "uptime-bars";
  bars.setAttribute(
    "aria-label",
    history.percentage === null
      ? `${component.name}: el historial comienza hoy`
      : `${component.name}: ${history.percentage}% de los ${history.totalChecks} controles del período sin problemas`,
  );

  history.details.forEach((detail, index) => {
    const bar = document.createElement("span");
    bar.className = "uptime-day";
    bar.dataset.status = detail.status;
    bar.title = dayTitle(history.days[index], detail);
    bars.append(bar);
  });

  const meta = document.createElement("div");
  meta.className = "uptime-meta";
  const period = document.createElement("span");
  period.textContent = "90 días atrás";
  const percentage = document.createElement("strong");
  percentage.textContent =
    history.percentage === null
      ? "Comienza hoy"
      : `${history.percentage.toLocaleString("es-AR")}% de los controles sin problemas`;
  const today = document.createElement("span");
  today.textContent = "Hoy";
  meta.append(period, percentage, today);

  wrapper.append(bars, meta);
  return wrapper;
}

function incidentRow(incident) {
  const article = document.createElement("article");
  article.className = "incident";
  article.dataset.state = incident.resolvedAt ? "resolved" : "open";

  const marker = document.createElement("span");
  marker.className = "incident-marker";
  marker.setAttribute("aria-hidden", "true");

  const copy = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = incident.title;
  const description = document.createElement("p");
  description.textContent = incident.message;
  copy.append(title, description);

  // Los controles son espaciados: sabemos entre qué dos el servicio dejó de
  // responder, no el minuto exacto en que empezó.
  if (incident.lastHealthyAt) {
    const window = document.createElement("p");
    window.className = "incident-window";
    window.textContent = `Detectado entre el control de las ${formatTime(
      incident.lastHealthyAt,
    )} y el de las ${formatTime(incident.startedAt)}.`;
    copy.append(window);
  }

  const time = document.createElement("time");
  time.dateTime = incident.resolvedAt || incident.startedAt;
  time.textContent = incident.resolvedAt
    ? `Resuelto · ${formatDate(incident.resolvedAt)}`
    : `En curso · ${formatDate(incident.startedAt)}`;

  article.append(marker, copy, time);
  return article;
}

function emptyHistory() {
  const article = document.createElement("article");
  article.className = "empty-state";

  const mark = document.createElement("span");
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "✓";

  const message = document.createElement("p");
  message.textContent = "No hubo interrupciones confirmadas en los últimos 90 días.";

  article.append(mark, message);
  return article;
}

/**
 * Las falsas alarmas van juntas en un solo bloque. Son dos docenas de avisos
 * idénticos que no dicen nada del servicio: sueltos tapaban el historial.
 */
function falseAlarmGroup(incidents) {
  const details = document.createElement("details");
  details.className = "false-alarms";

  const summary = document.createElement("summary");
  const fechas = incidents
    .map((incident) => Date.parse(incident.startedAt))
    .filter((value) => !Number.isNaN(value))
    .sort((first, second) => first - second);
  const periodo = fechas.length
    ? ` entre el ${shortDateFormatter.format(fechas[0])} y el ${shortDateFormatter.format(
        fechas[fechas.length - 1],
      )}`
    : "";
  summary.textContent =
    incidents.length === 1
      ? `1 falsa alarma del control${periodo}`
      : `${incidents.length} falsas alarmas del control${periodo}`;

  const explanation = document.createElement("p");
  explanation.textContent =
    "El control externo no pudo consultar la plataforma y publicó cada intento fallido como una interrupción. Revisamos el servidor y no hubo caída.";

  const list = document.createElement("ul");
  for (const incident of incidents) {
    const item = document.createElement("li");
    item.textContent = formatDate(incident.startedAt);
    list.append(item);
  }

  details.append(summary, explanation, list);
  return details;
}

async function loadJson(path) {
  const response = await fetch(`${path}?v=${Date.now()}`, {
    cache: "no-store",
    credentials: "omit",
  });

  if (!response.ok) {
    throw new Error(`No se pudo cargar ${path}`);
  }

  return response.json();
}

async function loadSnapshot() {
  const response = await fetch(`./data/snapshot.json?v=${Date.now()}`, {
    cache: "no-store", credentials: "omit",
  });
  // A Pages rollback can precede the Worker rollout. Only an older Worker's
  // missing route may use the previous format; an unavailable store is an error.
  if (response.status === 404) {
    const [status, incidents] = await Promise.all([
      loadJson("./data/status.json"), loadJson("./data/incidents.json"),
    ]);
    return { status, incidents };
  }
  if (!response.ok) throw new Error("No se pudo cargar el estado");
  return response.json();
}

async function render() {
  if (renderInFlight) {
    return;
  }

  renderInFlight = true;
  const componentsContainer = document.querySelector("#components");
  const incidentsContainer = document.querySelector("#incidents");
  const title = document.querySelector("#estado-general");
  const message = document.querySelector("#status-message");
  const lastUpdated = document.querySelector("#last-updated");

  try {
    const { status: statusData, incidents: incidentsData } = await loadSnapshot();

    const overall = safeStatus(statusData.overall);
    document.body.dataset.overall = overall;
    title.textContent = OVERALL_TITLES[overall];
    message.textContent = statusData.message;
    lastUpdated.textContent = `Comprobado: ${formatDate(statusData.checkedAt)}`;

    componentsContainer.replaceChildren();
    const line = document.createElement("div");
    line.className = "signal-line";
    line.setAttribute("aria-hidden", "true");
    const componentRows = statusData.components.map((component) => {
      const row = componentRow(component);
      row.append(uptimeChart(component, statusData));
      return row;
    });
    componentsContainer.append(line, ...componentRows);

    const falseAlarms = incidentsData.incidents.filter(
      (incident) => incident.kind === "measurement_error",
    );
    const outages = incidentsData.incidents.filter(
      (incident) => incident.kind !== "measurement_error",
    );

    incidentsContainer.replaceChildren(
      ...(outages.length ? outages.map(incidentRow) : [emptyHistory()]),
      ...(falseAlarms.length ? [falseAlarmGroup(falseAlarms)] : []),
    );
  } catch {
    document.body.dataset.overall = "unknown";
    title.textContent = OVERALL_TITLES.unknown;
    message.textContent =
      "La página está disponible, pero no pudo leer la última verificación. Volvé a intentar en unos minutos.";
    lastUpdated.textContent = "Datos momentáneamente no disponibles";
  } finally {
    renderInFlight = false;
  }
}

void render();
window.setInterval(() => {
  if (document.visibilityState === "visible") void render();
}, AUTO_REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void render();
  }
});
