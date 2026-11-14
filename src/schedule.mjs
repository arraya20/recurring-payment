import { Temporal } from "@js-temporal/polyfill";

export function parseStart(local, timezone) {
  if (typeof timezone !== "string" || !timezone) {
    throw new Error("An IANA time zone is required.");
  }

  let plain;
  try {
    plain = Temporal.PlainDateTime.from(local);
  } catch {
    throw new Error("Start date and time are invalid.");
  }

  let zoned;
  try {
    zoned = plain.toZonedDateTime(timezone, { disambiguation: "compatible" });
  } catch {
    throw new Error("Time zone is invalid.");
  }

  return {
    epochMs: Number(zoned.epochMilliseconds),
    local: zoned.toPlainDateTime().toString(),
    utc: zoned.toInstant().toString(),
    timezone,
    anchorDay: plain.day
  };
}

export function occurrenceAt(schedule, index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("Occurrence index is invalid.");
  }

  const start = Temporal.Instant.fromEpochMilliseconds(
    schedule.startEpochMs
  ).toZonedDateTimeISO(schedule.timezone);
  let due;

  if (schedule.cadence === "WEEKLY") {
    due = start.add({ weeks: index });
  } else if (schedule.cadence === "MONTHLY") {
    const target = start
      .toPlainDateTime()
      .with({ day: 1 })
      .add({ months: index });
    due = target
      .with({ day: Math.min(schedule.anchorDay, target.daysInMonth) })
      .toZonedDateTime(schedule.timezone, { disambiguation: "compatible" });
  } else {
    throw new Error("Cadence must be WEEKLY or MONTHLY.");
  }

  return {
    index,
    epochMs: Number(due.epochMilliseconds),
    local: due.toPlainDateTime().toString(),
    utc: due.toInstant().toString(),
    timezone: schedule.timezone
  };
}

export function nextOccurrence(schedule, nowMs = Date.now()) {
  const max = schedule.occurrenceLimit ?? 10000;
  for (let index = 0; index < max; index++) {
    const due = occurrenceAt(schedule, index);
    if (schedule.endEpochMs && due.epochMs > schedule.endEpochMs) return null;
    if (due.epochMs >= nowMs) return due;
  }
  return null;
}

export function dueOccurrences(schedule, afterMs, nowMs, limit = 12) {
  const due = [];
  const max = schedule.occurrenceLimit ?? 10000;
  for (let index = 0; index < max && due.length < limit; index++) {
    const item = occurrenceAt(schedule, index);
    if (schedule.endEpochMs && item.epochMs > schedule.endEpochMs) break;
    if (item.epochMs > nowMs) break;
    if (item.epochMs > afterMs) due.push(item);
  }
  return due;
}
