import { digest } from "./digest.mjs";
import { dispatch } from "./dispatcher.mjs";
import {
  NETWORK,
  REVIEW_TEXT,
  USDC,
  LIMITS
} from "./constants.mjs";
import {
  normalizeTerms,
  prepareUnsigned,
  reconcileOccurrence,
  reviewValidation,
  validateOccurrence
} from "./engine.mjs";
import { nextOccurrence, parseStart } from "./schedule.mjs";
import * as store from "./store.mjs";

const SESSION_COOKIE = "__Host-recurring_payment";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const MAX_ACTIVE_SCHEDULES = 10;
const MAX_BODY_BYTES = 16 * 1024;
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains"
};

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

async function readJson(request) {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw httpError("Content-Type must be application/json.", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw httpError("A JSON request body is required.");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw httpError("Request body is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let body;
  try {
    body = JSON.parse(
      new TextDecoder().decode(
        chunks.reduce((all, chunk) => {
          const joined = new Uint8Array(all.length + chunk.length);
          joined.set(all);
          joined.set(chunk, all.length);
          return joined;
        }, new Uint8Array())
      )
    );
  } catch {
    throw httpError("A valid JSON request body is required.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError("JSON request body must be an object.");
  }
  return body;
}

function cookieValue(request) {
  const cookie = request.headers.get("cookie") || "";
  const prefix = `${SESSION_COOKIE}=`;
  const value = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
  if (!value) return null;
  const [workspaceId, capability, ...extra] = value.split(".");
  if (
    extra.length ||
    !/^[0-9a-f-]{36}$/i.test(workspaceId) ||
    !/^[0-9a-f-]{64}$/i.test(capability)
  ) {
    return null;
  }
  return { workspaceId, capability };
}

async function authenticate(request, env) {
  const session = cookieValue(request);
  if (
    !session ||
    !(await store.authenticate(
      env.DB,
      session.workspaceId,
      await digest({ capability: session.capability })
    ))
  ) {
    throw httpError("Workspace session is required.", 401);
  }
  return session.workspaceId;
}

function enforceSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw httpError("Cross-origin requests are not allowed.", 403);
  }
}

function sessionCookie(workspaceId, capability) {
  return `${SESSION_COOKIE}=${workspaceId}.${capability}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

function createScheduleInput(raw, workspaceId, scheduleId, revision, now) {
  const terms = normalizeTerms({
    sender: raw.sender,
    recipient: raw.recipient,
    asset: raw.asset,
    tokenContract: raw.tokenContract,
    amount: typeof raw.amount === "string" ? raw.amount : ""
  });
  const label = String(raw.label || "").trim();
  if (!label || label.length > 80) {
    throw new Error("Label must contain between 1 and 80 characters.");
  }
  const cadence = String(raw.cadence || "").toUpperCase();
  if (!["WEEKLY", "MONTHLY"].includes(cadence)) {
    throw new Error("Cadence must be WEEKLY or MONTHLY.");
  }
  const start = parseStart(raw.startLocal, raw.timezone);
  const end = raw.endLocal ? parseStart(raw.endLocal, raw.timezone) : null;
  if (end && end.epochMs < start.epochMs) {
    throw new Error("End date must not precede start date.");
  }
  const occurrenceLimit =
    raw.occurrenceLimit == null || raw.occurrenceLimit === ""
      ? null
      : Number(raw.occurrenceLimit);
  if (
    occurrenceLimit !== null &&
    (!Number.isInteger(occurrenceLimit) ||
      occurrenceLimit < 1 ||
      occurrenceLimit > 520)
  ) {
    throw new Error("Occurrence limit must be between 1 and 520.");
  }

  return {
    scheduleId,
    revision,
    workspaceId,
    active: true,
    label,
    ...terms,
    cadence,
    timezone: start.timezone,
    startEpochMs: start.epochMs,
    startLocal: start.local,
    anchorDay: start.anchorDay,
    endEpochMs: end?.epochMs ?? null,
    occurrenceLimit,
    lastScannedMs: start.epochMs - 1,
    nextDueMs: start.epochMs,
    createdAt: new Date(now).toISOString()
  };
}

async function newWorkspace(request, env) {
  const existing = cookieValue(request);
  if (
    existing &&
    (await store.authenticate(
      env.DB,
      existing.workspaceId,
      await digest({ capability: existing.capability })
    ))
  ) {
    return json({
      workspaceId: existing.workspaceId,
      network: NETWORK.name,
      chainId: NETWORK.chainId
    });
  }
  const workspaceId = crypto.randomUUID();
  const capability = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll(
    "-",
    ""
  );
  await store.createWorkspace(
    env.DB,
    workspaceId,
    await digest({ capability }),
    new Date().toISOString()
  );
  return json(
    { workspaceId, network: NETWORK.name, chainId: NETWORK.chainId },
    201,
    { "set-cookie": sessionCookie(workspaceId, capability) }
  );
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === "/api/meta" && method === "GET") {
    return json({
      engineVersion: "recurring-payment-agent/2.0.0",
      network: NETWORK,
      reviewStatement: REVIEW_TEXT,
      usdc: USDC,
      unsignedOnly: true,
      signing: false,
      broadcast: false,
      catchUpLimit: LIMITS.catchUp
    });
  }
  if (path === "/api/workspaces" && method === "POST") {
    enforceSameOrigin(request);
    return newWorkspace(request, env);
  }

  if (method !== "GET") enforceSameOrigin(request);
  const workspaceId = await authenticate(request, env);

  if (path === "/api/schedules" && method === "POST") {
    if ((await store.countActive(env.DB, workspaceId)) >= MAX_ACTIVE_SCHEDULES) {
      throw httpError("Active schedule limit reached.", 409);
    }
    const input = await readJson(request);
    const schedule = createScheduleInput(
      input,
      workspaceId,
      crypto.randomUUID(),
      1,
      Date.now()
    );
    await store.createSchedule(env.DB, schedule);
    return json(
      { schedule, next: nextOccurrence(schedule) },
      201
    );
  }
  if (path === "/api/schedules" && method === "GET") {
    return json({
      schedules: await store.listSchedules(env.DB, workspaceId),
      heartbeat: await store.heartbeat(env.DB)
    });
  }
  const scheduleMatch = path.match(
    /^\/api\/schedules\/([0-9a-f-]+)(?:\/(revise|pause|resume))?$/i
  );
  if (scheduleMatch) {
    const [, scheduleId, action] = scheduleMatch;
    const current = await store.latestSchedule(env.DB, workspaceId, scheduleId);
    if (!current) throw httpError("Schedule not found.", 404);
    if (!action && method === "GET") {
      return json({ ...current, next: nextOccurrence(current) });
    }
    if ((action === "pause" || action === "resume") && method === "POST") {
      return json(
        await store.setActive(
          env.DB,
          workspaceId,
          scheduleId,
          action === "resume"
        )
      );
    }
    if (action === "revise" && method === "POST") {
      const input = await readJson(request);
      const revised = createScheduleInput(
        input,
        workspaceId,
        scheduleId,
        current.revision + 1,
        Date.now()
      );
      return json({
        schedule: await store.reviseSchedule(env.DB, current, revised),
        next: nextOccurrence(revised)
      });
    }
  }
  if (path === "/api/occurrences" && method === "GET") {
    return json({
      occurrences: await store.listOccurrences(env.DB, workspaceId)
    });
  }
  const occurrenceMatch = path.match(
    /^\/api\/occurrences\/([0-9a-f-]+)(?:\/(review|prepare|attach|reconcile|export|revalidate))?$/i
  );
  if (occurrenceMatch) {
    const [, id, action] = occurrenceMatch;
    let occurrence = await store.getOccurrence(env.DB, workspaceId, id);
    if (!occurrence) throw httpError("Occurrence not found.", 404);
    if (!action && method === "GET") return json(occurrence);

    if (action === "review" && method === "POST") {
      const body = await readJson(request);
      const review = await reviewValidation(
        occurrence.validation,
        body.accepted === true
      );
      await store.saveReview(env.DB, id, review);
      return json(await store.getOccurrence(env.DB, workspaceId, id));
    }
    if (action === "prepare" && method === "POST") {
      const earlier = await store.earlierUnresolved(env.DB, occurrence);
      if (earlier) {
        throw httpError(
          `Earlier occurrence ${earlier.id} is unresolved in state ${earlier.state}.`,
          409
        );
      }
      const fresh = await validateOccurrence(occurrence.terms);
      const unsigned = await prepareUnsigned(
        occurrence.validation,
        occurrence.review,
        fresh
      );
      await store.saveUnsigned(env.DB, id, unsigned);
      return json(await store.getOccurrence(env.DB, workspaceId, id));
    }
    if (action === "attach" && method === "POST") {
      const body = await readJson(request);
      if (typeof body.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.hash)) {
        throw new Error("Transaction hash is invalid.");
      }
      const saved = await store.attachHash(env.DB, workspaceId, id, body.hash);
      if (!saved) throw httpError("Occurrence is not ready for a hash.", 409);
      return json(saved);
    }
    if (action === "reconcile" && method === "POST") {
      if (!occurrence.transactionHash) {
        throw httpError("Attach a transaction hash first.", 409);
      }
      const result = await reconcileOccurrence(
        occurrence,
        occurrence.transactionHash
      );
      await store.saveReconciliation(
        env.DB,
        id,
        occurrence.transactionHash,
        result
      );
      return json(await store.getOccurrence(env.DB, workspaceId, id));
    }
    if (action === "revalidate" && method === "POST") {
      const claimed = await store.claimRevalidation(env.DB, workspaceId, id);
      if (!claimed) {
        throw httpError("Occurrence cannot be revalidated in its current state.", 409);
      }
      try {
        const validation = await validateOccurrence(claimed.terms);
        const state =
          validation.status === "VALIDATED"
            ? "READY_FOR_REVIEW"
            : validation.issues.some((issue) => /INSUFFICIENT/.test(issue.code))
              ? "BLOCKED_INSUFFICIENT_FUNDS"
              : "VALIDATION_FAILED";
        await store.saveValidation(
          env.DB,
          id,
          validation,
          state,
          validation.issues.map((issue) => issue.message).join(" ")
        );
      } catch (error) {
        await store.saveValidation(
          env.DB,
          id,
          { status: "ERROR", error: { message: String(error?.message || error) } },
          "VALIDATION_FAILED",
          String(error?.message || error)
        );
      }
      return json(await store.getOccurrence(env.DB, workspaceId, id));
    }
  }

  throw httpError("API route not found.", 404);
}

function secureAssetResponse(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        const clientHash = await digest({
          client: request.headers.get("cf-connecting-ip") || "unknown"
        });
        const now = Date.now();
        const windowStart = Math.floor(now / 60000) * 60000;
        if (
          !(await store.consumeRateLimit(
            env.DB,
            clientHash,
            windowStart,
            LIMITS.requestsPerMinute
          ))
        ) {
          return json(
            { error: "Request limit exceeded. Try again shortly." },
            429,
            {
              "retry-after": String(60 - Math.floor((now % 60000) / 1000))
            }
          );
        }
        return await handleApi(request, env);
      }
      return secureAssetResponse(await env.ASSETS.fetch(request));
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500) {
        console.error(
          JSON.stringify({
            message: "request_failed",
            error: String(error?.message || error)
          })
        );
      }
      return json(
        {
          error:
            status >= 500
              ? "The request could not be completed."
              : String(error?.message || "Invalid request.")
        },
        status
      );
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      dispatch(env, {
        source: "CRON",
        nowMs: controller.scheduledTime
      })
    );
  }
};
