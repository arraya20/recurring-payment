function parseJson(value) {
  return value == null ? null : JSON.parse(value);
}

function rowSchedule(row) {
  if (!row) return null;
  return {
    scheduleId: row.schedule_id,
    revision: row.revision,
    workspaceId: row.workspace_id,
    active: Boolean(row.active),
    label: row.label,
    sender: row.sender,
    recipient: row.recipient,
    asset: row.asset,
    tokenContract: row.token_contract,
    amount: row.amount,
    cadence: row.cadence,
    timezone: row.timezone,
    startEpochMs: row.start_epoch_ms,
    startLocal: row.start_local,
    anchorDay: row.anchor_day,
    endEpochMs: row.end_epoch_ms,
    occurrenceLimit: row.occurrence_limit,
    lastScannedMs: row.last_scanned_ms,
    nextDueMs: row.next_due_ms,
    createdAt: row.created_at
  };
}

function rowOccurrence(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.occurrence_key,
    workspaceId: row.workspace_id,
    scheduleId: row.schedule_id,
    revision: row.revision,
    index: row.occurrence_index,
    scheduledAtMs: row.scheduled_at_ms,
    scheduledLocal: row.scheduled_local,
    timezone: row.timezone,
    detectedAt: row.detected_at,
    validatedAt: row.validated_at,
    preparedAt: row.prepared_at,
    state: row.state,
    group: row.group_name,
    provenance: row.provenance,
    terms: parseJson(row.terms_json),
    validation: parseJson(row.validation_json),
    review: parseJson(row.review_json),
    unsignedTransaction: parseJson(row.unsigned_json),
    transactionHash: row.transaction_hash,
    reconciliation: parseJson(row.reconciliation_json),
    failureReason: row.failure_reason,
    updatedAt: row.updated_at
  };
}

const scheduleInsert = `INSERT INTO schedules (
  schedule_id, revision, workspace_id, active, label, sender, recipient,
  asset, token_contract, amount, cadence, timezone, start_epoch_ms, start_local,
  anchor_day, end_epoch_ms, occurrence_limit, last_scanned_ms, next_due_ms, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function bindSchedule(db, schedule) {
  return db
    .prepare(scheduleInsert)
    .bind(
      schedule.scheduleId,
      schedule.revision,
      schedule.workspaceId,
      schedule.active ? 1 : 0,
      schedule.label,
      schedule.sender,
      schedule.recipient,
      schedule.asset,
      schedule.tokenContract,
      schedule.amount,
      schedule.cadence,
      schedule.timezone,
      schedule.startEpochMs,
      schedule.startLocal,
      schedule.anchorDay,
      schedule.endEpochMs,
      schedule.occurrenceLimit,
      schedule.lastScannedMs,
      schedule.nextDueMs,
      schedule.createdAt
    );
}

export async function createWorkspace(db, id, capabilityHash, createdAt) {
  await db
    .prepare(
      "INSERT INTO workspaces(id, capability_hash, created_at) VALUES (?, ?, ?)"
    )
    .bind(id, capabilityHash, createdAt)
    .run();
}

export async function authenticate(db, id, capabilityHash) {
  const row = await db
    .prepare(
      "SELECT 1 AS authenticated FROM workspaces WHERE id = ? AND capability_hash = ?"
    )
    .bind(id, capabilityHash)
    .first();
  return Boolean(row);
}

export async function countActive(db, workspaceId) {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM schedules WHERE workspace_id = ? AND active = 1"
    )
    .bind(workspaceId)
    .first();
  return Number(row?.count || 0);
}

export async function createSchedule(db, schedule) {
  await bindSchedule(db, schedule).run();
  return schedule;
}

export async function reviseSchedule(db, current, revised) {
  await db.batch([
    db
      .prepare(
        "UPDATE schedules SET active = 0 WHERE schedule_id = ? AND revision = ? AND workspace_id = ?"
      )
      .bind(current.scheduleId, current.revision, current.workspaceId),
    bindSchedule(db, revised)
  ]);
  return revised;
}

export async function latestSchedule(db, workspaceId, scheduleId) {
  return rowSchedule(
    await db
      .prepare(
        "SELECT * FROM schedules WHERE workspace_id = ? AND schedule_id = ? ORDER BY revision DESC LIMIT 1"
      )
      .bind(workspaceId, scheduleId)
      .first()
  );
}

export async function listSchedules(db, workspaceId) {
  const result = await db
    .prepare(
      `SELECT s.* FROM schedules s
       JOIN (
         SELECT schedule_id, MAX(revision) AS revision
         FROM schedules WHERE workspace_id = ? GROUP BY schedule_id
       ) latest ON latest.schedule_id = s.schedule_id AND latest.revision = s.revision
       WHERE s.workspace_id = ?
       ORDER BY s.created_at DESC`
    )
    .bind(workspaceId, workspaceId)
    .all();
  return (result.results || []).map(rowSchedule);
}

export async function setActive(db, workspaceId, scheduleId, active) {
  const current = await latestSchedule(db, workspaceId, scheduleId);
  if (!current) return null;
  await db
    .prepare(
      "UPDATE schedules SET active = ? WHERE workspace_id = ? AND schedule_id = ? AND revision = ?"
    )
    .bind(active ? 1 : 0, workspaceId, scheduleId, current.revision)
    .run();
  return { ...current, active };
}

export async function activeSchedules(db) {
  const result = await db
    .prepare(
      "SELECT * FROM schedules WHERE active = 1 ORDER BY next_due_ms LIMIT 200"
    )
    .all();
  return (result.results || []).map(rowSchedule);
}

export async function updateScan(db, schedule, lastScannedMs, nextDueMs) {
  await db
    .prepare(
      "UPDATE schedules SET last_scanned_ms = ?, next_due_ms = ? WHERE schedule_id = ? AND revision = ? AND active = 1"
    )
    .bind(lastScannedMs, nextDueMs, schedule.scheduleId, schedule.revision)
    .run();
}

export async function insertOccurrence(db, occurrence) {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO occurrences (
        id, occurrence_key, workspace_id, schedule_id, revision, occurrence_index,
        scheduled_at_ms, scheduled_local, timezone, detected_at, state, group_name,
        provenance, terms_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      occurrence.id,
      occurrence.key,
      occurrence.workspaceId,
      occurrence.scheduleId,
      occurrence.revision,
      occurrence.index,
      occurrence.scheduledAtMs,
      occurrence.scheduledLocal,
      occurrence.timezone,
      occurrence.detectedAt,
      occurrence.state,
      occurrence.group,
      occurrence.provenance,
      JSON.stringify(occurrence.terms),
      occurrence.updatedAt
    )
    .run();
  return Number(result.meta?.changes || 0) > 0;
}

export async function claimOccurrence(db, id) {
  const row = await db
    .prepare(
      `UPDATE occurrences
       SET state = 'VALIDATING', group_name = 'pending', updated_at = ?
       WHERE id = ? AND state = 'PENDING'
       RETURNING *`
    )
    .bind(new Date().toISOString(), id)
    .first();
  return rowOccurrence(row);
}

export async function saveValidation(
  db,
  id,
  validation,
  state,
  reason = null
) {
  const now = new Date().toISOString();
  const group = state === "READY_FOR_REVIEW" ? "pending" : "failed";
  await db
    .prepare(
      `UPDATE occurrences
       SET validation_json = ?, validated_at = ?, state = ?, group_name = ?,
           failure_reason = ?, updated_at = ?
       WHERE id = ? AND state = 'VALIDATING'`
    )
    .bind(
      JSON.stringify(validation),
      now,
      state,
      group,
      reason,
      now,
      id
    )
    .run();
}

export async function pendingOccurrences(db) {
  const result = await db
    .prepare(
      "SELECT * FROM occurrences WHERE state = 'PENDING' ORDER BY scheduled_at_ms LIMIT 50"
    )
    .all();
  return (result.results || []).map(rowOccurrence);
}

export async function reconciliationCandidates(db) {
  const result = await db
    .prepare(
      `SELECT * FROM occurrences
       WHERE transaction_hash IS NOT NULL
         AND state IN ('AWAITING_CONFIRMATION', 'RECONCILIATION_REQUIRED')
       ORDER BY updated_at LIMIT 50`
    )
    .all();
  return (result.results || []).map(rowOccurrence);
}

export async function unresolvedForSchedule(db, workspaceId, scheduleId) {
  return rowOccurrence(
    await db
      .prepare(
        `SELECT * FROM occurrences
         WHERE workspace_id = ? AND schedule_id = ?
           AND state NOT IN ('PAID', 'FAILED_ONCHAIN')
         ORDER BY scheduled_at_ms LIMIT 1`
      )
      .bind(workspaceId, scheduleId)
      .first()
  );
}

export async function claimRevalidation(db, workspaceId, id) {
  const row = await db
    .prepare(
      `UPDATE occurrences
       SET state = 'VALIDATING', group_name = 'pending', failure_reason = NULL,
           review_json = NULL, unsigned_json = NULL, updated_at = ?
       WHERE workspace_id = ? AND id = ?
         AND state IN ('BLOCKED_INSUFFICIENT_FUNDS', 'VALIDATION_FAILED')
       RETURNING *`
    )
    .bind(new Date().toISOString(), workspaceId, id)
    .first();
  return rowOccurrence(row);
}

export async function getOccurrence(db, workspaceId, id) {
  return rowOccurrence(
    await db
      .prepare(
        "SELECT * FROM occurrences WHERE workspace_id = ? AND id = ?"
      )
      .bind(workspaceId, id)
      .first()
  );
}

export async function earlierUnresolved(db, occurrence) {
  return db
    .prepare(
      `SELECT id, state FROM occurrences
       WHERE workspace_id = ? AND schedule_id = ? AND scheduled_at_ms < ?
         AND state NOT IN ('PAID', 'FAILED_ONCHAIN')
       ORDER BY scheduled_at_ms LIMIT 1`
    )
    .bind(
      occurrence.workspaceId,
      occurrence.scheduleId,
      occurrence.scheduledAtMs
    )
    .first();
}

export async function listOccurrences(db, workspaceId) {
  const result = await db
    .prepare(
      `SELECT * FROM occurrences
       WHERE workspace_id = ? ORDER BY scheduled_at_ms DESC LIMIT 200`
    )
    .bind(workspaceId)
    .all();
  return (result.results || []).map(rowOccurrence);
}

export async function saveReview(db, id, review) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE occurrences SET review_json = ?, updated_at = ?
       WHERE id = ? AND state = 'READY_FOR_REVIEW'`
    )
    .bind(JSON.stringify(review), now, id)
    .run();
}

export async function saveUnsigned(db, id, unsigned) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE occurrences
       SET unsigned_json = ?, prepared_at = ?, state = 'PREPARED_UNSIGNED',
           group_name = 'pending', updated_at = ?
       WHERE id = ? AND state = 'READY_FOR_REVIEW'`
    )
    .bind(JSON.stringify(unsigned), now, now, id)
    .run();
}

export async function attachHash(db, workspaceId, id, hash) {
  const now = new Date().toISOString();
  try {
    const row = await db
      .prepare(
        `UPDATE occurrences
         SET transaction_hash = ?, state = 'AWAITING_CONFIRMATION',
             group_name = 'pending', updated_at = ?
         WHERE workspace_id = ? AND id = ? AND state = 'PREPARED_UNSIGNED'
         RETURNING *`
      )
      .bind(hash.toLowerCase(), now, workspaceId, id)
      .first();
    return rowOccurrence(row);
  } catch (error) {
    if (/UNIQUE/i.test(String(error?.message))) {
      throw Object.assign(
        new Error("Transaction hash is already assigned to another occurrence."),
        { status: 409 }
      );
    }
    throw error;
  }
}

export async function saveReconciliation(db, id, hash, reconciliation) {
  const now = new Date().toISOString();
  const state = reconciliation.state;
  const group =
    state === "PAID"
      ? "paid"
      : state === "FAILED_ONCHAIN" || state === "RECONCILIATION_REQUIRED"
        ? "failed"
        : "pending";
  const result = await db
    .prepare(
      `UPDATE occurrences
       SET reconciliation_json = ?, state = ?, group_name = ?, failure_reason = ?,
           updated_at = ?
       WHERE id = ? AND transaction_hash = ?
         AND state IN ('AWAITING_CONFIRMATION', 'RECONCILIATION_REQUIRED')
       RETURNING *`
    )
    .bind(
      JSON.stringify(reconciliation),
      state,
      group,
      state === "RECONCILIATION_REQUIRED"
        ? reconciliation.error?.message || null
        : null,
      now,
      id,
      hash.toLowerCase()
    )
    .first();
  return rowOccurrence(result);
}

export async function saveHeartbeat(db, heartbeat) {
  await db
    .prepare(
      `INSERT INTO scheduler_state (
        singleton, heartbeat_at, invocation_id, source, schedules_scanned,
        occurrences_created, duplicates_ignored
      ) VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        heartbeat_at = excluded.heartbeat_at,
        invocation_id = excluded.invocation_id,
        source = excluded.source,
        schedules_scanned = excluded.schedules_scanned,
        occurrences_created = excluded.occurrences_created,
        duplicates_ignored = excluded.duplicates_ignored`
    )
    .bind(
      heartbeat.heartbeatAt,
      heartbeat.invocationId,
      heartbeat.source,
      heartbeat.schedulesScanned,
      heartbeat.occurrencesCreated,
      heartbeat.duplicatesIgnored
    )
    .run();
}

export async function heartbeat(db) {
  return db
    .prepare("SELECT * FROM scheduler_state WHERE singleton = 1")
    .first();
}

export async function consumeRateLimit(db, clientHash, windowStart, limit) {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits(client_hash, window_start, request_count)
       VALUES (?, ?, 1)
       ON CONFLICT(client_hash, window_start)
       DO UPDATE SET request_count = request_count + 1
       RETURNING request_count`
    )
    .bind(clientHash, windowStart)
    .first();
  return Number(row?.request_count) <= limit;
}

export async function pruneRateLimits(db, beforeMs) {
  await db
    .prepare("DELETE FROM rate_limits WHERE window_start < ?")
    .bind(beforeMs)
    .run();
}
