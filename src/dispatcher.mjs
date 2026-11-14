import { LIMITS } from "./constants.mjs";
import { digest } from "./digest.mjs";
import { reconcileOccurrence, validateOccurrence } from "./engine.mjs";
import { dueOccurrences, nextOccurrence } from "./schedule.mjs";
import * as store from "./store.mjs";

function occurrenceTerms(schedule, due) {
  return {
    scheduleId: schedule.scheduleId,
    revision: schedule.revision,
    sender: schedule.sender,
    recipient: schedule.recipient,
    asset: schedule.asset,
    tokenContract: schedule.tokenContract,
    amount: schedule.amount,
    scheduledAt: due.utc
  };
}

export async function dispatch(
  env,
  {
    source = "CRON",
    nowMs = Date.now(),
    validator = validateOccurrence,
    reconciler = reconcileOccurrence
  } = {}
) {
  await store.pruneRateLimits(env.DB, nowMs - 2 * 60 * 1000);
  const invocationId = crypto.randomUUID();
  const detectedAt = new Date(nowMs).toISOString();
  const schedules = await store.activeSchedules(env.DB);
  let created = 0;
  let duplicates = 0;

  for (const schedule of schedules) {
    const due = dueOccurrences(
      schedule,
      schedule.lastScannedMs,
      nowMs,
      LIMITS.catchUp
    );
    for (const item of due) {
      const key = await digest({
        scheduleId: schedule.scheduleId,
        revision: schedule.revision,
        scheduledAt: item.utc
      });
      const inserted = await store.insertOccurrence(env.DB, {
        id: crypto.randomUUID(),
        key,
        workspaceId: schedule.workspaceId,
        scheduleId: schedule.scheduleId,
        revision: schedule.revision,
        index: item.index,
        scheduledAtMs: item.epochMs,
        scheduledLocal: item.local,
        timezone: item.timezone,
        detectedAt,
        state: "PENDING",
        group: "pending",
        provenance: source,
        terms: occurrenceTerms(schedule, item),
        updatedAt: detectedAt
      });
      if (inserted) created++;
      else duplicates++;
    }

    const cursor =
      due.length > 0 ? due[due.length - 1].epochMs : nowMs;
    await store.updateScan(
      env.DB,
      schedule,
      cursor,
      nextOccurrence(schedule, nowMs + 1)?.epochMs ?? null
    );
  }

  const pending = await store.pendingOccurrences(env.DB);
  for (const occurrence of pending) {
    const claimed = await store.claimOccurrence(env.DB, occurrence.id);
    if (!claimed) continue;

    try {
      const validation = await validator(claimed.terms);
      const state =
        validation.status === "VALIDATED"
          ? "READY_FOR_REVIEW"
          : validation.issues.some((issue) => /INSUFFICIENT/.test(issue.code))
            ? "BLOCKED_INSUFFICIENT_FUNDS"
            : "VALIDATION_FAILED";
      await store.saveValidation(
        env.DB,
        claimed.id,
        validation,
        state,
        validation.issues.map((issue) => issue.message).join(" ")
      );
    } catch (error) {
      const message = String(error?.message || error);
      await store.saveValidation(
        env.DB,
        claimed.id,
        { status: "ERROR", error: { message } },
        "VALIDATION_FAILED",
        message
      );
    }
  }

  const submitted = await store.reconciliationCandidates(env.DB);
  for (const occurrence of submitted) {
    const hash = occurrence.transactionHash;
    let reconciliation;
    try {
      reconciliation = await reconciler(occurrence, hash);
    } catch (error) {
      const message = String(error?.message || error);
      reconciliation = {
        state: "RECONCILIATION_REQUIRED",
        hash,
        error: { message },
        checkedAt: new Date(nowMs).toISOString()
      };
      console.error(
        JSON.stringify({
          message: "occurrence_reconciliation_failed",
          occurrenceId: occurrence.id,
          error: message
        })
      );
    }
    await store.saveReconciliation(env.DB, occurrence.id, hash, reconciliation);
  }

  const heartbeat = {
    heartbeatAt: new Date().toISOString(),
    invocationId,
    source,
    schedulesScanned: schedules.length,
    occurrencesCreated: created,
    duplicatesIgnored: duplicates
  };
  await store.saveHeartbeat(env.DB, heartbeat);
  return heartbeat;
}
