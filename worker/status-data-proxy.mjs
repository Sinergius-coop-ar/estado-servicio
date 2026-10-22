const REPOSITORY = "Sinergius-coop-ar/estado-servicio";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_STATUS_AGE_MS = 2 * 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 6_000;

const PUBLIC_FILES = new Map([
  ["/data/status.json", "status.json"],
  ["/data/incidents.json", "incidents.json"],
]);

const STATUS_VALUES = new Set([
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "maintenance",
  "unknown",
]);

const COMPONENT_IDS = new Set([
  "status_page",
  "public_site",
  "meeting_api",
  "alternate_domain",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value, maximum = 500) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isIsoDate(value) {
  if (typeof value !== "string") {
    return false;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function validateStatus(document, nowMs) {
  if (
    !isObject(document) ||
    !STATUS_VALUES.has(document.overall) ||
    !isIsoDate(document.checkedAt) ||
    !isString(document.message, 500) ||
    !Array.isArray(document.components) ||
    document.components.length !== COMPONENT_IDS.size
  ) {
    return false;
  }

  const checkedAt = Date.parse(document.checkedAt);
  if (checkedAt > nowMs + 5 * 60 * 1000 || nowMs - checkedAt > MAX_STATUS_AGE_MS) {
    return false;
  }

  const ids = new Set();
  for (const component of document.components) {
    if (
      !isObject(component) ||
      !COMPONENT_IDS.has(component.id) ||
      ids.has(component.id) ||
      !isString(component.name, 100) ||
      !isString(component.description, 300) ||
      !STATUS_VALUES.has(component.status)
    ) {
      return false;
    }
    ids.add(component.id);
  }

  return (
    ids.size === COMPONENT_IDS.size &&
    isObject(document.history) &&
    isString(document.history.startedAt, 10) &&
    /^\d{4}-\d{2}-\d{2}$/.test(document.history.startedAt) &&
    Array.isArray(document.history.days) &&
    document.history.days.length <= 90
  );
}

export function validateIncidents(document) {
  if (!isObject(document) || !Array.isArray(document.incidents) || document.incidents.length > 500) {
    return false;
  }

  const ids = new Set();
  return document.incidents.every((incident) => {
    if (
      !isObject(incident) ||
      !isString(incident.id, 120) ||
      ids.has(incident.id) ||
      !isString(incident.title, 200) ||
      !isString(incident.message, 1_000) ||
      !isIsoDate(incident.startedAt) ||
      (incident.lastHealthyAt !== null &&
        incident.lastHealthyAt !== undefined &&
        !isIsoDate(incident.lastHealthyAt)) ||
      (incident.resolvedAt !== null && !isIsoDate(incident.resolvedAt)) ||
      (incident.kind !== undefined && !isString(incident.kind, 80))
    ) {
      return false;
    }
    ids.add(incident.id);
    return true;
  });
}

export async function readLimitedBody(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new Error("body_too_large");
  }

  if (!response.body) {
    throw new Error("empty_body");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("body_too_large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function jsonResponse(body, status, method, extraHeaders = {}) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });

  if (status !== 200) {
    headers.set("Retry-After", "60");
  }

  return new Response(method === "HEAD" ? null : body, { status, headers });
}

function classifyFailure(error) {
  if (error?.name === "AbortError") {
    return "timeout";
  }

  const knownReasons = new Set([
    "body_too_large",
    "empty_body",
    "invalid_document",
    "upstream_redirect",
    "upstream_status",
  ]);
  return knownReasons.has(error?.message) ? error.message : "unknown";
}

// Only used to bootstrap an empty Durable Object during rollout. An immutable
// commit avoids GitHub Raw's stale branch cache even before the first push.
export function createStatusDataProxy({ revision, fetchImpl = fetch, now = Date.now, logger = console } = {}) {
  return async function handle(request) {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return jsonResponse(JSON.stringify({ error: "method_not_allowed" }), 405, method);
    }

    const url = new URL(request.url);
    const filename = PUBLIC_FILES.get(url.pathname);
    if (!filename) {
      return jsonResponse(JSON.stringify({ error: "not_found" }), 404, method);
    }

    if (!/^[a-f0-9]{40}$/.test(revision ?? "")) {
      return jsonResponse(JSON.stringify({ error: "status_unavailable" }), 503, method);
    }
    const upstreamUrl =
      `https://raw.githubusercontent.com/${REPOSITORY}/${revision}/data/${filename}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      const upstream = await fetchImpl(upstreamUrl, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (upstream.redirected) {
        throw new Error("upstream_redirect");
      }
      if (upstream.status !== 200) {
        throw new Error("upstream_status");
      }

      const text = await readLimitedBody(upstream);
      const document = JSON.parse(text);
      const valid = filename === "status.json"
        ? validateStatus(document, now())
        : validateIncidents(document);

      if (!valid) {
        throw new Error("invalid_document");
      }

      return jsonResponse(`${JSON.stringify(document, null, 2)}\n`, 200, method, {
        "X-Status-Revision": revision,
      });
    } catch (error) {
      logger.warn?.("status_data_proxy_failure", {
        file: filename,
        reason: classifyFailure(error),
      });
      return jsonResponse(JSON.stringify({ error: "status_unavailable" }), 503, method);
    } finally {
      clearTimeout(timeout);
    }
  };
}
