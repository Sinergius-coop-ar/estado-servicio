import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const STATUS_PATH = new URL("../data/status.json", import.meta.url);
const INCIDENTS_PATH = new URL("../data/incidents.json", import.meta.url);
const MAX_HISTORY_DAYS = 90;
const MAX_RESPONSE_BYTES = 256 * 1024;
// Bot Fight Mode del plan Free no admite excepciones para monitores. Usar una
// huella HTTP convencional evita que Cloudflare desafíe el control legítimo,
// mientras el endpoint sensible sigue autenticado con su token independiente.
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function requestHeaders(healthToken = null) {
  return {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-AR,es;q=0.9,en;q=0.7",
    "Cache-Control": "no-cache",
    ...(healthToken ? { Authorization: `Bearer ${healthToken}` } : {}),
  };
}

export const TARGETS = [
  {
    id: "status_page",
    url: "https://estado.sinergius.coop.ar/",
    acceptedStatuses: [200],
    expectedText: "Estado de los servicios",
    additionalChecks: [
      {
        url: "https://estado.sinergius.coop.ar/data/status.json",
        acceptedStatuses: [200],
        expectedText: '"checkedAt"',
      },
    ],
  },
  {
    id: "public_site",
    url: "https://sinergius.coop.ar/",
    acceptedStatuses: [200],
    expectedText: "Sinergius",
  },
  {
    id: "meeting_api",
    url: "https://sinergius.coop.ar/api/meeting-health.php",
    acceptedStatuses: [204],
    expectedText: "",
    requiredEnv: "MEETING_HEALTH_TOKEN",
  },
  {
    id: "alternate_domain",
    url: "https://sinergius.com.ar/",
    acceptedStatuses: [200],
    expectedText: "Sinergius",
  },
];

/**
 * Destinos ajenos a la plataforma que sirven para saber si el problema es
 * nuestro o de quien controla. Cuando el control corre en un runner alquilado,
 * una salida a internet intermitente se veía igual que un servicio caído.
 */
export const NETWORK_CANARIES = [
  "https://api.github.com/zen",
  "https://www.cloudflare.com/cdn-cgi/trace",
];

const STATUS_MESSAGES = {
  operational: "No detectamos problemas en los servicios controlados.",
  partial_outage: "Detectamos problemas en una parte del servicio.",
  major_outage: "La plataforma no está respondiendo correctamente.",
};

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readBodyWithLimit(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("respuesta demasiado grande");
  }

  if (!response.body?.getReader) {
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      throw new Error("respuesta demasiado grande");
    }
    return body;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel("respuesta demasiado grande");
      throw new Error("respuesta demasiado grande");
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

export async function checkTarget(target, fetchImplementation = fetch, delayImplementation = delay) {
  let lastResult = { ok: false, httpStatus: null };

  const healthToken = target.requiredEnv ? process.env[target.requiredEnv] : null;
  if (target.requiredEnv && (!healthToken || healthToken.length < 32)) {
    return { id: target.id, ...lastResult };
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const endpoints = [target, ...(target.additionalChecks ?? [])];
      const checks = await Promise.all(endpoints.map(async (endpoint) => {
        const response = await fetchImplementation(endpoint.url, {
          headers: requestHeaders(healthToken),
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        });
        const body = await readBodyWithLimit(response);
        return {
          accepted: endpoint.acceptedStatuses.includes(response.status),
          contentMatches: body.toLowerCase().includes(endpoint.expectedText.toLowerCase()),
          httpStatus: response.status,
        };
      }));
      lastResult = {
        ok: checks.every(({ accepted, contentMatches }) => accepted && contentMatches),
        httpStatus: checks.find(({ accepted, contentMatches }) => !accepted || !contentMatches)?.httpStatus
          ?? checks[0].httpStatus,
      };
    } catch {
      lastResult = { ok: false, httpStatus: null };
    }

    if (lastResult.ok || attempt === 3) {
      break;
    }

    // Un corte de red suele durar más que unos segundos: espaciar los
    // reintentos evita confundirlo con un servicio caído.
    await delayImplementation(10_000);
  }

  return { id: target.id, ...lastResult };
}

/**
 * Confirma que el control tiene salida a internet. Si ningún destino externo
 * responde, lo que falla es la conexión de quien controla y el resultado no
 * dice nada sobre la plataforma.
 */
export async function hasNetworkAccess(fetchImplementation = fetch) {
  const attempts = NETWORK_CANARIES.map(async (url) => {
    const response = await fetchImplementation(url, {
      headers: requestHeaders(),
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok === true || response.status === 200;
  });

  const settled = await Promise.allSettled(attempts);
  return settled.some((result) => result.status === "fulfilled" && result.value === true);
}

export function overallFromResults(results) {
  const healthyCount = results.filter((result) => result.ok).length;

  if (healthyCount === results.length) {
    return "operational";
  }

  return healthyCount === 0 ? "major_outage" : "partial_outage";
}

function componentStatus(componentId, results, overall) {
  const directResult = results.find((result) => result.id === componentId);

  if (directResult) {
    return directResult.ok ? "operational" : "major_outage";
  }

  return overall;
}

export function updateStatusDocument(currentStatus, results, checkedAt, updateHistory = true) {
  const overall = overallFromResults(results);

  const nextStatus = {
    ...currentStatus,
    overall,
    checkedAt,
    message: STATUS_MESSAGES[overall],
    components: currentStatus.components.map((component) => ({
      ...component,
      status: componentStatus(component.id, results, overall),
    })),
  };

  return {
    ...nextStatus,
    history: updateHistory
      ? updateDailyHistory(currentStatus.history, nextStatus, checkedAt)
      : currentStatus.history,
  };
}

/**
 * Resume un día a partir de cuántos controles hubo y cuántos fallaron. Antes se
 * guardaba el peor resultado del día, así que un control fallido de treinta
 * pintaba la jornada entera como caída total.
 */
export function dayStatusFromCounts(checks, failedCount) {
  if (!checks || failedCount <= 0) {
    return "operational";
  }

  const ratio = failedCount / checks;

  if (ratio < 0.2) {
    return "degraded";
  }

  return ratio < 0.6 ? "partial_outage" : "major_outage";
}

function dayOverall(checks, failedChecks) {
  return dayStatusFromCounts(checks, failedChecks);
}

export function updateDailyHistory(currentHistory, nextStatus, checkedAt) {
  const date = checkedAt.slice(0, 10);
  const history = currentHistory ?? { startedAt: date, days: [] };
  const days = [...history.days];
  const existingIndex = days.findIndex((day) => day.date === date);
  const existing = existingIndex === -1 ? null : days[existingIndex];

  const checks = (existing?.checks ?? 0) + 1;
  const failed = { ...(existing?.failed ?? {}) };
  const legacyFailures = Object.values(failed);
  const previousFailedChecks = existing?.failedChecks
    ?? (legacyFailures.length ? Math.max(...legacyFailures) : 0);
  const failedChecks = previousFailedChecks + (nextStatus.overall === "operational" ? 0 : 1);

  for (const component of nextStatus.components) {
    const previousFailures = failed[component.id] ?? 0;
    failed[component.id] =
      previousFailures + (component.status === "operational" ? 0 : 1);
  }

  const nextDay = {
    date,
    checks,
    failed,
    failedChecks,
    overall: dayOverall(checks, failedChecks),
  };

  if (existingIndex === -1) {
    days.push(nextDay);
  } else {
    days[existingIndex] = nextDay;
  }

  return {
    startedAt: history.startedAt ?? date,
    days: days
      .filter((day) => Date.parse(`${day.date}T00:00:00Z`) >= Date.parse(checkedAt) - 89 * 86400000)
      .sort((first, second) => first.date.localeCompare(second.date)),
  };
}

function incidentTitle(status) {
  return status === "major_outage"
    ? "Interrupción del servicio"
    : "Interrupción parcial del servicio";
}

export function updateIncidentsDocument(
  currentIncidents,
  previousOverall,
  nextOverall,
  now,
  lastHealthyAt = null,
) {
  const incidents = [...currentIncidents.incidents];
  const openIncidentIndex = incidents.findIndex((incident) => !incident.resolvedAt);
  const wasHealthy = previousOverall === "operational";
  const isHealthy = nextOverall === "operational";

  if (wasHealthy && !isHealthy && openIncidentIndex === -1) {
    incidents.unshift({
      id: `automatic-${now.replaceAll(/[^0-9]/g, "").slice(0, 14)}`,
      title: incidentTitle(nextOverall),
      message: STATUS_MESSAGES[nextOverall],
      // El control es espaciado: lo único cierto es que entre este momento y el
      // control sano anterior algo dejó de responder.
      lastHealthyAt,
      startedAt: now,
      resolvedAt: null,
    });
  } else if (!wasHealthy && !isHealthy && openIncidentIndex !== -1) {
    incidents[openIncidentIndex] = {
      ...incidents[openIncidentIndex],
      title: incidentTitle(nextOverall),
      message: STATUS_MESSAGES[nextOverall],
    };
  } else if (!wasHealthy && isHealthy && openIncidentIndex !== -1) {
    incidents[openIncidentIndex] = {
      ...incidents[openIncidentIndex],
      message: "El funcionamiento normal fue restablecido.",
      resolvedAt: now,
    };
  }

  const cutoff = Date.parse(now) - MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  return {
    incidents: incidents.filter((incident) => Date.parse(incident.startedAt) >= cutoff),
  };
}

/**
 * Aplica una medición completa sobre los dos documentos persistidos. La salida
 * de una corrida debe ser la entrada de la siguiente: así cada control suma al
 * historial y un incidente abierto se conserva hasta una recuperación real.
 */
export function applyMeasurement(
  currentStatus,
  currentIncidents,
  results,
  checkedAt,
) {
  const nextStatus = updateStatusDocument(currentStatus, results, checkedAt, true);
  const nextIncidents = updateIncidentsDocument(
    currentIncidents,
    currentStatus.overall,
    nextStatus.overall,
    checkedAt,
    currentStatus.checkedAt ?? null,
  );

  return { nextStatus, nextIncidents };
}

async function main() {
  const [statusRaw, incidentsRaw] = await Promise.all([
    readFile(STATUS_PATH, "utf8"),
    readFile(INCIDENTS_PATH, "utf8"),
  ]);
  const currentStatus = JSON.parse(statusRaw);
  const currentIncidents = JSON.parse(incidentsRaw);
  const checkedAt = new Date().toISOString();
  const results = await Promise.all(TARGETS.map((target) => checkTarget(target)));

  if (!results.some((result) => result.ok) && !(await hasNetworkAccess())) {
    // Sin salida a internet no se puede afirmar nada: dejar el estado como
    // estaba en vez de publicar una caída que nadie comprobó.
    process.stdout.write(
      `${JSON.stringify({
        overall: currentStatus.overall,
        checkedAt,
        persisted: false,
        skipped: "sin salida a internet desde el control",
      })}\n`,
    );
    return;
  }

  const { nextStatus, nextIncidents } = applyMeasurement(
    currentStatus,
    currentIncidents,
    results,
    checkedAt,
  );

  await Promise.all([
    writeFile(STATUS_PATH, `${JSON.stringify(nextStatus, null, 2)}\n`, "utf8"),
    writeFile(INCIDENTS_PATH, `${JSON.stringify(nextIncidents, null, 2)}\n`, "utf8"),
  ]);

  process.stdout.write(
    `${JSON.stringify({
      overall: nextStatus.overall,
      checkedAt,
      persisted: true,
      persistRequired: true,
      results,
    })}\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  await main();
}
