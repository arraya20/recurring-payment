const $ = (selector) => document.querySelector(selector);
const elements = {
  status: $("#app-status"),
  form: $("#schedule-form"),
  schedules: $("#schedule-list"),
  heartbeat: $("#heartbeat"),
  updatedAt: $("#updated-at"),
  pending: $("#pending-list"),
  paid: $("#paid-list"),
  failed: $("#failed-list"),
  detail: $("#occurrence-detail"),
  emptyDetail: $("#occurrence-empty"),
  selectedState: $("#occurrence-state"),
  terms: $("#occurrence-terms"),
  validation: $("#validation-evidence"),
  unsigned: $("#unsigned-transaction"),
  failure: $("#failure-reason"),
  review: $("#review-accepted"),
  reviewButton: $("#review-button"),
  prepareButton: $("#prepare-button"),
  revalidateButton: $("#revalidate-button"),
  downloadButton: $("#download-button"),
  hash: $("#transaction-hash"),
  attachButton: $("#attach-button"),
  reconcileButton: $("#reconcile-button"),
  reconciliationNote: $("#reconciliation-note")
};

let selectedOccurrence = null;
let refreshInProgress = false;

function setStatus(message, kind = "info") {
  elements.status.textContent = message;
  elements.status.className = `notice notice-${kind}`;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body != null) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin"
  });
  const text = await response.text();
  let result;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("The server returned an unreadable response.");
  }
  if (!response.ok) {
    throw new Error(result.error || `Request failed (${response.status}).`);
  }
  return result;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function formatTime(value) {
  if (!value) return "No next payment";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString();
}

function setInitialScheduleTime() {
  const date = new Date(Date.now() + 60_000);
  const pad = (part) => String(part).padStart(2, "0");
  elements.form.elements.startLocal.value = [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  ].join("T");
  elements.form.elements.timezone.value =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function renderSchedules(schedules) {
  elements.schedules.replaceChildren();
  if (!schedules.length) {
    elements.schedules.append(
      node("p", "empty-state", "No schedules yet. Create one to begin.")
    );
    return;
  }

  for (const schedule of schedules) {
    const item = node("article", "schedule-item");
    const content = node("div", "schedule-content");
    content.append(
      node("h3", "", schedule.label),
      node(
        "p",
        "schedule-terms",
        `${schedule.amount} ${schedule.asset} · ${schedule.cadence.toLowerCase()}`
      ),
      node("p", "schedule-address", `${schedule.sender} → ${schedule.recipient}`)
    );
    const next = node("p", "next-time");
    next.append(
      node("strong", "", "Next "),
      document.createTextNode(
        schedule.active
          ? `${schedule.next?.local || "none"} ${schedule.timezone}`
          : "paused"
      )
    );
    if (schedule.next?.utc) {
      next.append(
        document.createElement("br"),
        node("span", "muted", `UTC ${schedule.next.utc}`)
      );
    }
    content.append(next);

    const actions = node("div", "schedule-actions");
    const badge = node(
      "span",
      `state-badge ${schedule.active ? "state-active" : "state-paused"}`,
      schedule.active ? "ACTIVE" : "PAUSED"
    );
    const toggle = node(
      "button",
      "button button-quiet",
      schedule.active ? "Pause" : "Resume"
    );
    toggle.type = "button";
    toggle.dataset.action = schedule.active ? "pause-schedule" : "resume-schedule";
    toggle.dataset.id = schedule.scheduleId;
    actions.append(badge, toggle);
    item.append(content, actions);
    elements.schedules.append(item);
  }
}

function renderOccurrenceGroup(container, occurrences, emptyText) {
  container.replaceChildren();
  if (!occurrences.length) {
    container.append(node("p", "empty-state", emptyText));
    return;
  }
  for (const occurrence of occurrences) {
    const row = node("div", "history-row");
    const select = node(
      "button",
      "history-select",
      `${occurrence.terms.amount} ${occurrence.terms.asset} · ${formatTime(
        occurrence.scheduledAtMs
      )}`
    );
    select.type = "button";
    select.dataset.action = "select-occurrence";
    select.dataset.id = occurrence.id;
    select.setAttribute(
      "aria-current",
      selectedOccurrence?.id === occurrence.id ? "true" : "false"
    );
    row.append(
      select,
      node("span", "state-badge", occurrence.state.replaceAll("_", " "))
    );
    container.append(row);
  }
}

function addDetailRow(label, value) {
  const term = node("dt", "", label);
  const definition = node("dd", "", value || "Not available");
  elements.terms.append(term, definition);
}

function updateOccurrenceActions(occurrence) {
  const state = occurrence.state;
  const readyForReview = state === "READY_FOR_REVIEW";
  const prepared = Boolean(occurrence.unsignedTransaction);
  const blocked = [
    "BLOCKED_INSUFFICIENT_FUNDS",
    "VALIDATION_FAILED"
  ].includes(state);
  elements.reviewButton.disabled =
    !readyForReview || !elements.review.checked || Boolean(occurrence.review);
  elements.prepareButton.disabled = !readyForReview || !occurrence.review;
  elements.revalidateButton.classList.toggle("hidden", !blocked);
  elements.downloadButton.disabled = !prepared;
  elements.attachButton.disabled = state !== "PREPARED_UNSIGNED";
  elements.reconcileButton.disabled =
    !occurrence.transactionHash ||
    !["AWAITING_CONFIRMATION", "RECONCILIATION_REQUIRED"].includes(state);
  elements.review.checked = Boolean(occurrence.review?.accepted);
}

function showOccurrence(occurrence) {
  selectedOccurrence = occurrence;
  elements.emptyDetail.classList.add("hidden");
  elements.detail.classList.remove("hidden");
  elements.selectedState.classList.remove("hidden");
  elements.selectedState.textContent = occurrence.state.replaceAll("_", " ");
  elements.selectedState.className = `state-badge state-${occurrence.group}`;
  $("#detail-title").textContent = `Occurrence · ${occurrence.scheduleId.slice(0, 8)}`;
  elements.terms.replaceChildren();
  addDetailRow("Schedule", `${occurrence.scheduleId} · revision ${occurrence.revision}`);
  addDetailRow("Scheduled local", `${occurrence.scheduledLocal} ${occurrence.timezone}`);
  addDetailRow("Scheduled UTC", new Date(occurrence.scheduledAtMs).toISOString());
  addDetailRow("Detected", occurrence.detectedAt);
  addDetailRow(
    "Lateness",
    `${Math.max(0, Date.parse(occurrence.detectedAt) - occurrence.scheduledAtMs)} ms`
  );
  addDetailRow(
    "Payment",
    `${occurrence.terms.amount} ${occurrence.terms.asset} → ${occurrence.terms.recipient}`
  );
  addDetailRow("Provenance", occurrence.provenance);
  addDetailRow("Transaction hash", occurrence.transactionHash);
  elements.validation.textContent = occurrence.validation
    ? JSON.stringify(occurrence.validation, null, 2)
    : "Validation has not run.";
  elements.unsigned.textContent = occurrence.unsignedTransaction
    ? JSON.stringify(occurrence.unsignedTransaction, null, 2)
    : "No unsigned transaction has been prepared.";
  elements.failure.textContent = occurrence.failureReason || "";
  elements.failure.classList.toggle("hidden", !occurrence.failureReason);
  elements.reconciliationNote.textContent = occurrence.reconciliation
    ? `Receipt check: ${occurrence.reconciliation.state}. A hash alone is not proof of payment.`
    : "A transaction hash is not proof of payment. Paid status requires a verified receipt.";
  elements.hash.value = occurrence.transactionHash || "";
  updateOccurrenceActions(occurrence);
}

async function refresh() {
  if (refreshInProgress) return;
  refreshInProgress = true;
  try {
    const [scheduleResult, occurrenceResult] = await Promise.all([
      api("/api/schedules"),
      api("/api/occurrences")
    ]);
    const schedules = await Promise.all(
      scheduleResult.schedules.map(async (schedule) => ({
        ...schedule,
        next: schedule.active
          ? (
              await api(
                `/api/schedules/${encodeURIComponent(schedule.scheduleId)}`
              )
            ).next
          : null
      }))
    );
    renderSchedules(schedules);
    elements.heartbeat.textContent = scheduleResult.heartbeat
      ? `${scheduleResult.heartbeat.source} · ${scheduleResult.heartbeat.heartbeat_at} · ${scheduleResult.heartbeat.occurrences_created} prepared`
      : "No scheduler heartbeat recorded yet.";

    const occurrences = occurrenceResult.occurrences;
    renderOccurrenceGroup(
      elements.pending,
      occurrences.filter((item) => item.group === "pending"),
      "No pending payments."
    );
    renderOccurrenceGroup(
      elements.paid,
      occurrences.filter((item) => item.group === "paid"),
      "No verified payments."
    );
    renderOccurrenceGroup(
      elements.failed,
      occurrences.filter((item) => item.group === "failed"),
      "No failed or blocked payments."
    );
    if (selectedOccurrence) {
      const current = occurrences.find((item) => item.id === selectedOccurrence.id);
      if (current) showOccurrence(current);
    }
    elements.updatedAt.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    setStatus("Workspace is up to date.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    refreshInProgress = false;
  }
}

async function initialize() {
  setStatus("Connecting to Pharos Mainnet…");
  const meta = await api("/api/meta");
  $("#network-label").textContent = `${meta.network.name} · chain ${meta.network.chainId}`;
  await api("/api/workspaces", { method: "POST", body: "{}" });
  setInitialScheduleTime();
  await refresh();
}

async function postAction(path, body = {}) {
  const result = await api(path, {
    method: "POST",
    body: JSON.stringify(body)
  });
  if (result?.id && result?.state) showOccurrence(result);
  else if (result?.occurrence) showOccurrence(result.occurrence);
  await refresh();
  return result;
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#create-schedule");
  button.disabled = true;
  setStatus("Saving schedule…");
  try {
    const data = new FormData(elements.form);
    await api("/api/schedules", {
      method: "POST",
      body: JSON.stringify({
        label: data.get("label"),
        sender: data.get("sender"),
        recipient: data.get("recipient"),
        amount: data.get("amount"),
        asset: data.get("asset"),
        tokenContract: data.get("tokenContract") || null,
        cadence: data.get("cadence"),
        startLocal: data.get("startLocal"),
        timezone: data.get("timezone"),
        endLocal: data.get("endLocal") || null,
        occurrenceLimit: data.get("occurrenceLimit") || null
      })
    });
    elements.form.reset();
    setInitialScheduleTime();
    await refresh();
    setStatus("Schedule created. The Cron scheduler will check its due time.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#asset").addEventListener("change", (event) => {
  const custom = event.target.value === "CUSTOM";
  $("#token-contract-field").classList.toggle("hidden", !custom);
  elements.form.elements.tokenContract.required = custom;
});

elements.review.addEventListener("change", () => {
  if (selectedOccurrence) updateOccurrenceActions(selectedOccurrence);
});

$("#refresh").addEventListener("click", refresh);

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  try {
    if (action === "select-occurrence") {
      showOccurrence(await api(`/api/occurrences/${encodeURIComponent(id)}`));
      return;
    }
    if (action === "pause-schedule" || action === "resume-schedule") {
      const endpoint = action === "pause-schedule" ? "pause" : "resume";
      await postAction(`/api/schedules/${encodeURIComponent(id)}/${endpoint}`);
    }
  } catch (error) {
    setStatus(error.message, "error");
  }
});

elements.reviewButton.addEventListener("click", async () => {
  if (!selectedOccurrence) return;
  try {
    await postAction(`/api/occurrences/${selectedOccurrence.id}/review`, {
      accepted: elements.review.checked
    });
  } catch (error) {
    setStatus(error.message, "error");
  }
});

elements.prepareButton.addEventListener("click", async () => {
  if (!selectedOccurrence) return;
  try {
    await postAction(`/api/occurrences/${selectedOccurrence.id}/prepare`);
  } catch (error) {
    setStatus(error.message, "error");
  }
});

elements.revalidateButton.addEventListener("click", async () => {
  if (!selectedOccurrence) return;
  try {
    await postAction(`/api/occurrences/${selectedOccurrence.id}/revalidate`);
  } catch (error) {
    setStatus(error.message, "error");
  }
});

elements.downloadButton.addEventListener("click", () => {
  if (!selectedOccurrence?.unsignedTransaction) return;
  const content = JSON.stringify(selectedOccurrence.unsignedTransaction, null, 2);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob([content], { type: "application/json" })
  );
  link.download = `unsigned-payment-${selectedOccurrence.id}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

elements.attachButton.addEventListener("click", async () => {
  if (!selectedOccurrence) return;
  try {
    await postAction(`/api/occurrences/${selectedOccurrence.id}/attach`, {
      hash: elements.hash.value.trim()
    });
  } catch (error) {
    setStatus(error.message, "error");
  }
});

elements.reconcileButton.addEventListener("click", async () => {
  if (!selectedOccurrence) return;
  try {
    await postAction(`/api/occurrences/${selectedOccurrence.id}/reconcile`);
  } catch (error) {
    setStatus(error.message, "error");
  }
});

initialize().catch((error) => setStatus(error.message, "error"));
window.setInterval(refresh, 30_000);
