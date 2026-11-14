import { test, run, assert, equal, throws } from "./harness.mjs";

const unitTests = [
  test("payment amounts convert exactly without floating point", async () => {
    const { parseUnitsExact } = await import("../src/amount.mjs");

    equal(parseUnitsExact("12.340001", 6), 12340001n);
    throws(() => parseUnitsExact("0.0000001", 6), "precision");
    throws(() => parseUnitsExact("1e3", 6), "decimal");
  }),

  test("monthly recurrence clamps short months and returns to the anchor day", async () => {
    const { occurrenceAt, parseStart } = await import("../src/schedule.mjs");
    const start = parseStart("2026-01-31T09:00", "Asia/Jakarta");
    const schedule = {
      startEpochMs: start.epochMs,
      timezone: start.timezone,
      cadence: "MONTHLY",
      anchorDay: start.anchorDay
    };

    equal(occurrenceAt(schedule, 1).local, "2026-02-28T09:00:00");
    equal(occurrenceAt(schedule, 2).local, "2026-03-31T09:00:00");
  }),

  test("weekly recurrence preserves local time across daylight saving changes", async () => {
    const { occurrenceAt, parseStart } = await import("../src/schedule.mjs");
    const start = parseStart("2026-03-01T09:00", "America/New_York");
    const schedule = {
      startEpochMs: start.epochMs,
      timezone: start.timezone,
      cadence: "WEEKLY",
      anchorDay: start.anchorDay
    };

    equal(occurrenceAt(schedule, 1).local, "2026-03-08T09:00:00");
  }),

  test("mainnet validation blocks a wrong chain and never accepts missing gas", async () => {
    const { validateOccurrence } = await import("../src/engine.mjs");
    const terms = {
      sender: "0x15ddce897d76ac39c188ade4d353711a60395315",
      recipient: "0x4117b9737f64d816be36f6c18c72409c98e4737c",
      asset: "PHRS",
      amount: "0.001"
    };
    const chain = {
      tools: [],
      async call(name) {
        if (name === "get_chain_info") return { chainId: 1672 };
        if (name === "get_block_number") return { blockNumberHex: "0x100" };
        if (name === "get_balance") return { balanceWei: "1000000000000000000" };
        if (name === "get_gas_price") return { gasPriceWei: "1000000000" };
        if (name === "estimate_gas") return { gas: "21000" };
        if (name === "eth_call") return { result: "0x" };
        throw new Error(`Unexpected tool: ${name}`);
      }
    };

    const validation = await validateOccurrence(terms, chain);
    equal(validation.status, "VALIDATED");
    equal(validation.terms.atomicAmount, "1000000000000000");
    equal(validation.transaction.to, terms.recipient);

    await throwsAsync(
      () => validateOccurrence(terms, { ...chain, call: async () => ({ chainId: 50002 }) }),
      "wrong network"
    );
    await throwsAsync(
      () =>
        validateOccurrence(terms, {
          ...chain,
          call: async (name) => {
            if (name === "get_chain_info") return { chainId: 1672 };
            if (name === "get_block_number") return { blockNumberHex: "0x100" };
            if (name === "get_balance") return { balanceWei: "1000000000000000000" };
            if (name === "get_gas_price") return {};
            throw new Error(`Unexpected tool: ${name}`);
          }
        }),
      "unavailable"
    );
  }),

  test("unsigned preparation requires an explicit reviewed validation", async () => {
    const { prepareUnsigned, reviewValidation, validateOccurrence } =
      await import("../src/engine.mjs");
    const terms = {
      scheduleId: "schedule-1",
      revision: 1,
      sender: "0x15ddce897d76ac39c188ade4d353711a60395315",
      recipient: "0x4117b9737f64d816be36f6c18c72409c98e4737c",
      asset: "PHRS",
      amount: "0.001",
      scheduledAt: "2026-11-14T00:00:00Z"
    };
    const chain = {
      tools: [],
      async call(name) {
        if (name === "get_chain_info") return { chainId: 1672 };
        if (name === "get_block_number") return { blockNumberHex: "0x100" };
        if (name === "get_balance") return { balanceWei: "1000000000000000000" };
        if (name === "get_gas_price") return { gasPriceWei: "1000000000" };
        if (name === "estimate_gas") return { gas: "21000" };
        if (name === "eth_call") return { result: "0x" };
        throw new Error(`Unexpected tool: ${name}`);
      }
    };
    const validation = await validateOccurrence(terms, chain);
    const review = await reviewValidation(validation, true);
    const unsigned = await prepareUnsigned(validation, review, validation);

    equal(unsigned.unsigned, true);
    equal(unsigned.signed, false);
    equal(unsigned.broadcast, false);
    equal(unsigned.transaction.chainId, 1672);
    await throwsAsync(
      () => prepareUnsigned(validation, { ...review, paymentDigest: "0xdead" }, validation),
      "changed"
    );
  }),

  test("custom ERC-20 uses on-chain decimals for exact transaction amounts", async () => {
    const { encodeFunctionResult } = await import("viem");
    const { ERC20_ABI } = await import("../src/constants.mjs");
    const { validateOccurrence } = await import("../src/engine.mjs");
    const token = "0x2222222222222222222222222222222222222222";
    const terms = {
      sender: "0x15ddce897d76ac39c188ade4d353711a60395315",
      recipient: "0x4117b9737f64d816be36f6c18c72409c98e4737c",
      asset: "CUSTOM",
      tokenContract: token,
      amount: "1.25"
    };
    const chain = {
      tools: [],
      async call(name, args) {
        if (name === "get_chain_info") return { chainId: 1672 };
        if (name === "get_block_number") return { blockNumberHex: "0x100" };
        if (name === "get_balance") return { balanceWei: "1000000000000000000" };
        if (name === "get_gas_price") return { gasPriceWei: "1000000000" };
        if (name === "get_code") return { code: "0x6000" };
        if (name === "estimate_gas") return { gas: "50000" };
        if (name === "eth_call") {
          const data = args.transaction.data;
          if (data.startsWith("0x313ce567")) {
            return {
              result: encodeFunctionResult({
                abi: ERC20_ABI,
                functionName: "decimals",
                result: 18
              })
            };
          }
          if (data.startsWith("0x95d89b41")) {
            return {
              result: encodeFunctionResult({
                abi: ERC20_ABI,
                functionName: "symbol",
                result: "TOK"
              })
            };
          }
          if (data.startsWith("0x70a08231")) {
            return {
              result: encodeFunctionResult({
                abi: ERC20_ABI,
                functionName: "balanceOf",
                result: 2000000000000000000n
              })
            };
          }
          if (data.startsWith("0xa9059cbb")) {
            return {
              result: encodeFunctionResult({
                abi: ERC20_ABI,
                functionName: "transfer",
                result: true
              })
            };
          }
        }
        throw new Error(`Unexpected tool: ${name}`);
      }
    };

    const validation = await validateOccurrence(terms, chain);
    equal(validation.status, "VALIDATED");
    equal(validation.terms.atomicAmount, "1250000000000000000");
    equal(validation.transaction.to, token);
  }),

  test("reconciliation rejects a transaction that does not match scheduled terms", async () => {
    const { reconcileOccurrence } = await import("../src/engine.mjs");
    const hash = `0x${"1".repeat(64)}`;
    const occurrence = {
      terms: {
        sender: "0x15ddce897d76ac39c188ade4d353711a60395315",
        recipient: "0x4117b9737f64d816be36f6c18c72409c98e4737c",
        asset: "PHRS",
        atomicAmount: "1000000000000000"
      },
      unsignedTransaction: {
        transaction: {
          from: "0x15ddce897d76ac39c188ade4d353711a60395315",
          to: "0x4117b9737f64d816be36f6c18c72409c98e4737c",
          value: "0x38d7ea4c68000",
          data: "0x"
        }
      }
    };
    const chain = {
      async call(name) {
        if (name === "get_chain_info") return { chainId: 1672 };
        if (name === "get_transaction") {
          return {
            hash,
            from: occurrence.terms.sender,
            to: occurrence.terms.recipient,
            value: "0x1",
            input: "0x"
          };
        }
        if (name === "get_transaction_receipt") {
          return { transactionHash: hash, status: "0x1", blockNumber: "0xf0", logs: [] };
        }
        if (name === "get_block_number") return { blockNumberHex: "0x100" };
        throw new Error(`Unexpected tool: ${name}`);
      }
    };

    await throwsAsync(
      () => reconcileOccurrence(occurrence, hash, chain),
      "value"
    );
  }),

  test("reconciliation distinguishes pending, paid, reverted, and unavailable receipts", async () => {
    const { reconcileOccurrence } = await import("../src/engine.mjs");
    const hash = `0x${"5".repeat(64)}`;
    const occurrence = {
      terms: {
        sender: "0x15ddce897d76ac39c188ade4d353711a60395315",
        recipient: "0x4117b9737f64d816be36f6c18c72409c98e4737c",
        asset: "PHRS",
        atomicAmount: "1000000000000000"
      },
      unsignedTransaction: {
        transaction: {
          from: "0x15ddce897d76ac39c188ade4d353711a60395315",
          to: "0x4117b9737f64d816be36f6c18c72409c98e4737c",
          value: "0x38d7ea4c68000",
          data: "0x"
        }
      }
    };
    const run = (receipt, failReceipt = false) =>
      reconcileOccurrence(occurrence, hash, {
        async call(name) {
          if (name === "get_chain_info") return { chainId: 1672 };
          if (name === "get_transaction") {
            return {
              hash,
              from: occurrence.terms.sender,
              to: occurrence.terms.recipient,
              value: "0x38d7ea4c68000",
              input: "0x"
            };
          }
          if (name === "get_transaction_receipt") {
            if (failReceipt) throw new Error("RPC unavailable");
            return receipt;
          }
          if (name === "get_block_number") return { blockNumberHex: "0xf0" };
          throw new Error(`Unexpected tool: ${name}`);
        }
      });

    equal((await run(null)).state, "AWAITING_CONFIRMATION");
    equal(
      (await run({ transactionHash: hash, status: "0x1", blockNumber: "0xf0" }))
        .state,
      "PAID"
    );
    equal(
      (await run({ transactionHash: hash, status: "0x0", blockNumber: "0xf0" }))
        .state,
      "FAILED_ONCHAIN"
    );
    equal((await run(null, true)).state, "RECONCILIATION_REQUIRED");
  }),

  test("D1 persistence scopes workspaces and claims each occurrence once", async () => {
    const store = await import("../src/store.mjs");
    const { createTestD1 } = await import("./d1-test.mjs");
    const { database, close } = await createTestD1();
    const now = "2026-11-14T00:00:00.000Z";
    await store.createWorkspace(database, "workspace-1", "hash-1", now);
    equal(await store.authenticate(database, "workspace-1", "hash-1"), true);
    equal(await store.authenticate(database, "workspace-1", "other"), false);

    await store.createSchedule(database, {
      scheduleId: "schedule-1",
      revision: 1,
      workspaceId: "workspace-1",
      active: true,
      label: "Rent",
      sender: "0x15ddce897d76ac39c188ade4d353711a60395315",
      recipient: "0x4117b9737f64d816be36f6c18c72409c98e4737c",
      asset: "PHRS",
      tokenContract: null,
      amount: "0.001",
      cadence: "WEEKLY",
      timezone: "UTC",
      startEpochMs: 1794614400000,
      startLocal: "2026-11-14T00:00",
      anchorDay: 14,
      endEpochMs: null,
      occurrenceLimit: 12,
      lastScannedMs: 1794614399999,
      nextDueMs: 1794614400000,
      createdAt: now
    });
    const occurrence = {
      id: "occurrence-1",
      key: "key-1",
      workspaceId: "workspace-1",
      scheduleId: "schedule-1",
      revision: 1,
      index: 0,
      scheduledAtMs: 1794614400000,
      scheduledLocal: "2026-11-14T00:00:00",
      timezone: "UTC",
      detectedAt: now,
      state: "PENDING",
      group: "pending",
      provenance: "CRON",
      terms: { amount: "0.001" },
      updatedAt: now
    };
    equal(await store.insertOccurrence(database, occurrence), true);
    equal(
      await store.insertOccurrence(database, { ...occurrence, id: "duplicate" }),
      false
    );
    equal((await store.claimOccurrence(database, occurrence.id)).state, "VALIDATING");
    equal(await store.claimOccurrence(database, occurrence.id), null);

    await store.saveValidation(database, occurrence.id, {}, "READY_FOR_REVIEW");
    await store.saveUnsigned(database, occurrence.id, {
      transaction: { from: "sender", to: "recipient", value: "0x0" }
    });
    const second = {
      ...occurrence,
      id: "occurrence-2",
      key: "key-2",
      index: 1,
      scheduledAtMs: occurrence.scheduledAtMs + 1,
      state: "READY_FOR_REVIEW"
    };
    await store.insertOccurrence(database, second);
    await store.saveUnsigned(database, second.id, {
      transaction: { from: "sender", to: "recipient", value: "0x0" }
    });
    const hash = `0x${"a".repeat(64)}`;
    await store.attachHash(database, "workspace-1", occurrence.id, hash);
    try {
      await store.attachHash(database, "workspace-1", second.id, hash);
      throw new Error("duplicate transaction hash was accepted");
    } catch (error) {
      equal(error.status, 409);
      assert(error.message.includes("already assigned"));
    }
    close();
  }),

  test("Worker creates private workspaces and persists validated schedules", async () => {
    const worker = (await import("../src/worker.mjs")).default;
    const { createTestD1 } = await import("./d1-test.mjs");
    const { database, close } = await createTestD1();
    const env = {
      DB: database,
      ASSETS: { fetch: async () => new Response("asset not found", { status: 404 }) }
    };
    const missingOrigin = await worker.fetch(
      new Request("https://agent.test/api/workspaces", { method: "POST" }),
      env
    );
    equal(missingOrigin.status, 403);
    const createWorkspace = await worker.fetch(
      new Request("https://agent.test/api/workspaces", {
        method: "POST",
        headers: { origin: "https://agent.test" }
      }),
      env
    );
    equal(createWorkspace.status, 201);
    const setCookie = createWorkspace.headers.get("set-cookie");
    assert(setCookie.includes("HttpOnly"));
    assert(setCookie.includes("SameSite=Strict"));
    const cookie = setCookie.split(";")[0];
    const workspace = await createWorkspace.json();
    equal(Object.hasOwn(workspace, "capability"), false);

    const createSchedule = await worker.fetch(
      new Request("https://agent.test/api/schedules", {
        method: "POST",
        headers: {
          cookie,
          origin: "https://agent.test",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          label: "Monthly rent",
          sender: "0x15ddce897d76ac39c188ade4d353711a60395315",
          recipient: "0x4117b9737f64d816be36f6c18c72409c98e4737c",
          asset: "PHRS",
          amount: "0.001",
          cadence: "MONTHLY",
          startLocal: "2099-11-14T09:00",
          timezone: "Asia/Jakarta"
        })
      }),
      env
    );
    equal(createSchedule.status, 201);
    const created = await createSchedule.json();
    equal(created.schedule.amount, "0.001");
    equal(created.schedule.active, true);
    equal(created.next.local, "2099-11-14T09:00:00");

    const list = await worker.fetch(
      new Request("https://agent.test/api/schedules", { headers: { cookie } }),
      env
    );
    equal((await list.json()).schedules.length, 1);
    const resumedWorkspace = await worker.fetch(
      new Request("https://agent.test/api/workspaces", {
        method: "POST",
        headers: {
          cookie,
          origin: "https://agent.test"
        }
      }),
      env
    );
    equal((await resumedWorkspace.json()).workspaceId, workspace.workspaceId);
    close();
  }),

  test("concurrent Cron runs create and validate each due occurrence once", async () => {
    const { dispatch } = await import("../src/dispatcher.mjs");
    const store = await import("../src/store.mjs");
    const { createTestD1 } = await import("./d1-test.mjs");
    const { database, close } = await createTestD1();
    const { parseStart } = await import("../src/schedule.mjs");
    const start = parseStart("2026-11-01T09:00", "UTC");
    const schedule = {
      scheduleId: "cron-1",
      revision: 1,
      workspaceId: "workspace-cron",
      active: true,
      label: "Weekly",
      sender: "0x15ddce897d76ac39c188ade4d353711a60395315",
      recipient: "0x4117b9737f64d816be36f6c18c72409c98e4737c",
      asset: "PHRS",
      tokenContract: null,
      amount: "0.001",
      cadence: "WEEKLY",
      timezone: "UTC",
      startEpochMs: start.epochMs,
      startLocal: start.local,
      anchorDay: start.anchorDay,
      endEpochMs: null,
      occurrenceLimit: null,
      lastScannedMs: start.epochMs - 1,
      nextDueMs: start.epochMs,
      createdAt: start.utc
    };
    await store.createWorkspace(database, schedule.workspaceId, "hash", start.utc);
    await store.createSchedule(database, schedule);
    let validationCalls = 0;
    const validator = async () => {
      validationCalls++;
      return { status: "VALIDATED", issues: [] };
    };
    const env = { DB: database };
    const nowMs = start.epochMs + 5 * 7 * 86400000;

    await Promise.all([
      dispatch(env, { nowMs, validator }),
      dispatch(env, { nowMs, validator })
    ]);

    const occurrences = await store.listOccurrences(database, schedule.workspaceId);
    equal(occurrences.length, 6);
    equal(validationCalls, 6);
    equal(occurrences.every((item) => item.state === "READY_FOR_REVIEW"), true);
    close();
  }),

  test("Cron catch-up advances through its backlog without skipping occurrences", async () => {
    const { dispatch } = await import("../src/dispatcher.mjs");
    const store = await import("../src/store.mjs");
    const { createTestD1 } = await import("./d1-test.mjs");
    const { database, close } = await createTestD1();
    const { parseStart } = await import("../src/schedule.mjs");
    const start = parseStart("2025-01-01T00:00", "UTC");
    const schedule = {
      scheduleId: "catch-up",
      revision: 1,
      workspaceId: "workspace-catchup",
      active: true,
      label: "Payroll",
      sender: "0x15ddce897d76ac39c188ade4d353711a60395315",
      recipient: "0x4117b9737f64d816be36f6c18c72409c98e4737c",
      asset: "PHRS",
      tokenContract: null,
      amount: "0.001",
      cadence: "WEEKLY",
      timezone: "UTC",
      startEpochMs: start.epochMs,
      startLocal: start.local,
      anchorDay: start.anchorDay,
      endEpochMs: null,
      occurrenceLimit: null,
      lastScannedMs: start.epochMs - 1,
      nextDueMs: start.epochMs,
      createdAt: start.utc
    };
    await store.createWorkspace(database, schedule.workspaceId, "hash", start.utc);
    await store.createSchedule(database, schedule);
    const env = { DB: database };
    const validator = async () => ({ status: "VALIDATED", issues: [] });
    const nowMs = start.epochMs + 30 * 7 * 86400000;

    await dispatch(env, { nowMs, validator });
    equal((await store.listOccurrences(database, schedule.workspaceId)).length, 12);
    await dispatch(env, { nowMs, validator });
    equal((await store.listOccurrences(database, schedule.workspaceId)).length, 24);
    close();
  }),

  test("Cron reconciles submitted transactions and retries RPC failures", async () => {
    const { dispatch } = await import("../src/dispatcher.mjs");
    const store = await import("../src/store.mjs");
    const { createTestD1 } = await import("./d1-test.mjs");
    const { database, close } = await createTestD1();
    const workspaceId = "workspace-reconcile";
    const nowMs = Date.parse("2026-11-14T00:00:00.000Z");
    const now = new Date(nowMs).toISOString();
    await store.createWorkspace(database, workspaceId, "hash", now);
    await store.createSchedule(database, {
      scheduleId: "reconcile-1",
      revision: 1,
      workspaceId,
      active: false,
      label: "Rent",
      sender: "0x15ddce897d76ac39c188ade4d353711a60395315",
      recipient: "0x4117b9737f64d816be36f6c18c72409c98e4737c",
      asset: "PHRS",
      tokenContract: null,
      amount: "0.001",
      cadence: "WEEKLY",
      timezone: "UTC",
      startEpochMs: nowMs + 86400000,
      startLocal: "2026-11-15T00:00",
      anchorDay: 15,
      endEpochMs: null,
      occurrenceLimit: null,
      lastScannedMs: nowMs,
      nextDueMs: nowMs + 86400000,
      createdAt: now
    });

    const expectedStates = new Map([
      [`0x${"1".repeat(64)}`, "AWAITING_CONFIRMATION"],
      [`0x${"2".repeat(64)}`, "PAID"],
      [`0x${"3".repeat(64)}`, "FAILED_ONCHAIN"],
      [`0x${"4".repeat(64)}`, "RECONCILIATION_REQUIRED"]
    ]);
    for (const [index, [hash]] of [...expectedStates].entries()) {
      const id = `occurrence-${index}`;
      const sender = "0x15ddce897d76ac39c188ade4d353711a60395315";
      const recipient = "0x4117b9737f64d816be36f6c18c72409c98e4737c";
      await store.insertOccurrence(database, {
        id,
        key: `key-${index}`,
        workspaceId,
        scheduleId: "reconcile-1",
        revision: 1,
        index,
        scheduledAtMs: nowMs + index,
        scheduledLocal: "2026-11-14T00:00:00",
        timezone: "UTC",
        detectedAt: now,
        state: "READY_FOR_REVIEW",
        group: "pending",
        provenance: "CRON",
        terms: {
          sender,
          recipient,
          asset: "PHRS",
          atomicAmount: "1000000000000000"
        },
        updatedAt: now
      });
      await store.saveUnsigned(database, id, {
        transaction: { from: sender, to: recipient, value: "0x38d7ea4c68000" }
      });
      await store.attachHash(database, workspaceId, id, hash);
    }

    await dispatch(
      { DB: database },
      {
        nowMs,
        validator: async () => ({ status: "VALIDATED", issues: [] }),
        reconciler: async (_occurrence, hash) => {
          if (hash === `0x${"4".repeat(64)}`) throw new Error("RPC unavailable");
          return {
            state: expectedStates.get(hash),
            hash,
            checkedAt: now
          };
        }
      }
    );

    const occurrences = await store.listOccurrences(database, workspaceId);
    equal(occurrences.length, 4);
    for (const occurrence of occurrences) {
      equal(occurrence.state, expectedStates.get(occurrence.transactionHash));
    }
    equal(
      occurrences.find((item) => item.transactionHash === `0x${"4".repeat(64)}`)
        .failureReason.includes("RPC unavailable"),
      true
    );
    close();
  }),

  test("public API limits repeated requests from the same client", async () => {
    const worker = (await import("../src/worker.mjs")).default;
    const { createTestD1 } = await import("./d1-test.mjs");
    const { database, close } = await createTestD1();
    const env = {
      DB: database,
      ASSETS: { fetch: async () => new Response("asset not found", { status: 404 }) }
    };
    let response;
    for (let attempt = 0; attempt < 91; attempt++) {
      response = await worker.fetch(
        new Request("https://agent.test/api/meta", {
          headers: { "cf-connecting-ip": "203.0.113.7" }
        }),
        env
      );
      if (attempt < 90) equal(response.status, 200);
    }
    equal(response.status, 429);
    close();
  }),

  test("dashboard exposes real schedule history and unsigned-only payment controls", async () => {
    const { readFile } = await import("node:fs/promises");
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

    assert(html.includes('id="schedule-form"'));
    assert(html.includes('id="next-payment"'));
    assert(html.includes('id="pending-list"'));
    assert(html.includes('id="paid-list"'));
    assert(html.includes('id="failed-list"'));
    assert(html.includes('src="/app.js"'));
    assert(!/\son(?:click|load)=/i.test(html));
    assert(html.includes("never signs or broadcasts"));
    assert(script.includes("/api/schedules"));
    assert(script.includes("/api/occurrences"));
    assert(script.includes("/reconcile"));
  })
];

run(unitTests);

async function throwsAsync(fn, match) {
  try {
    await fn();
  } catch (error) {
    if (!String(error.message).includes(match)) {
      throw new Error(`wrong error: got "${error.message}"`);
    }
    return;
  }
  throw new Error("expected a throw, but nothing was thrown");
}
