import {
  decodeEventLog,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress
} from "viem";
import {
  parseBigInt,
  parseUnitsExact,
  toHex,
  validateDecimalAmount
} from "./amount.mjs";
import {
  ENGINE_VERSION,
  ERC20_ABI,
  LIMITS,
  NETWORK,
  REVIEW_TEXT,
  USDC
} from "./constants.mjs";
import { digest } from "./digest.mjs";
import { withChainMcp } from "./mcp.mjs";

function cleanAddress(value, label) {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new Error(`${label} is not a valid EVM address.`);
  }
  const address = getAddress(value).toLowerCase();
  if (/^0x0{40}$/.test(address)) {
    throw new Error(`${label} cannot be the zero address.`);
  }
  return address;
}

function supportsBlockPin(tools, name) {
  const tool = tools.find((entry) => entry.name === name);
  return Object.hasOwn(tool?.inputSchema?.properties || {}, "block");
}

function toolFailure(error) {
  const message = String(error?.message || error);
  return {
    kind: /execution reverted|\brevert(?:ed)?\b/i.test(message)
      ? "EVM_REVERT"
      : /timeout|fetch failed|network|429|rate/i.test(message)
        ? "TRANSPORT_ERROR"
        : "RPC_ERROR",
    message
  };
}

export function normalizeTerms(input) {
  const asset = String(input.asset || "").toUpperCase();
  if (!["PHRS", "USDC", "CUSTOM"].includes(asset)) {
    throw new Error("Asset must be PHRS, USDC, or CUSTOM.");
  }

  const sender = cleanAddress(input.sender, "Sender");
  const recipient = cleanAddress(input.recipient, "Recipient");
  if (sender === recipient) throw new Error("Sender and recipient must differ.");

  let tokenContract = null;
  let decimals = 18;
  if (asset === "USDC") {
    tokenContract = USDC.address;
    decimals = USDC.decimals;
  } else if (asset === "CUSTOM") {
    tokenContract = cleanAddress(input.tokenContract, "Token contract");
    decimals = null;
  }

  const amount = String(input.amount || "");
  if (decimals === null) validateDecimalAmount(amount);
  else parseUnitsExact(amount, decimals);
  return {
    ...input,
    sender,
    recipient,
    asset,
    tokenContract,
    amount,
    decimals
  };
}

function termsDigest(terms) {
  return digest({
    sender: terms.sender,
    recipient: terms.recipient,
    asset: terms.asset,
    tokenContract: terms.tokenContract,
    amount: terms.amount,
    atomicAmount: terms.atomicAmount,
    chainId: NETWORK.chainId,
    scheduledAt: terms.scheduledAt,
    scheduleId: terms.scheduleId,
    revision: terms.revision
  });
}

export async function validateOccurrence(input, injected, now = new Date()) {
  const terms = normalizeTerms(input);
  const run = async ({ call, tools }) => {
    const trace = [];
    const invoke = async (name, args = {}) => {
      const startedAt = new Date().toISOString();
      try {
        const result = await call(name, args);
        trace.push({
          name,
          args,
          startedAt,
          completedAt: new Date().toISOString(),
          status: "OK"
        });
        return result;
      } catch (error) {
        trace.push({
          name,
          args,
          startedAt,
          completedAt: new Date().toISOString(),
          status: "FAILED",
          error: toolFailure(error)
        });
        throw error;
      }
    };

    const chain = await invoke("get_chain_info");
    if (Number(chain.chainId) !== NETWORK.chainId) {
      throw new Error("Chain MCP returned the wrong network.");
    }
    const block = await invoke("get_block_number");
    const blockNumber = block.blockNumberHex ?? block.blockNumber ?? block.number;
    if (blockNumber == null) throw new Error("Observation block is unavailable.");
    const pin = (name, args) =>
      supportsBlockPin(tools, name) ? { ...args, block: blockNumber } : args;
    const native = await invoke(
      "get_balance",
      pin("get_balance", { address: terms.sender })
    );
    const gasPriceData = await invoke("get_gas_price");
    const nativeBalance = parseBigInt(
      String(native.balanceWei ?? native.balance ?? ""),
      "Native balance"
    );
    const gasPrice = parseBigInt(
      String(gasPriceData.gasPriceWei ?? gasPriceData.gasPrice ?? ""),
      "Gas price"
    );

    let decimals = terms.decimals;
    let symbol = terms.asset;
    let tokenBalance = null;
    let transaction;

    if (terms.asset === "PHRS") {
      terms.atomicAmount = parseUnitsExact(terms.amount, 18).toString();
      transaction = {
        from: terms.sender,
        to: terms.recipient,
        value: toHex(terms.atomicAmount),
        data: "0x"
      };
    } else {
      const codeResult = await invoke(
        "get_code",
        pin("get_code", { address: terms.tokenContract })
      );
      if (!codeResult.code || /^0x0*$/i.test(codeResult.code)) {
        throw new Error("Token contract bytecode is unavailable.");
      }
      const readToken = async (functionName, args = []) => {
        const data = encodeFunctionData({
          abi: ERC20_ABI,
          functionName,
          args
        });
        const result = await invoke(
          "eth_call",
          pin("eth_call", {
            transaction: { to: terms.tokenContract, data }
          })
        );
        return decodeFunctionResult({
          abi: ERC20_ABI,
          functionName,
          data: result.result
        });
      };

      if (terms.asset === "CUSTOM") {
        decimals = Number(await readToken("decimals"));
        symbol = String(await readToken("symbol"));
        if (
          !Number.isInteger(decimals) ||
          decimals < 0 ||
          decimals > 255 ||
          !symbol
        ) {
          throw new Error("Custom token metadata is invalid.");
        }
      }

      tokenBalance = BigInt(await readToken("balanceOf", [terms.sender]));
      terms.atomicAmount = parseUnitsExact(terms.amount, decimals).toString();
      const data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [terms.recipient, BigInt(terms.atomicAmount)]
      });
      const decoded = decodeFunctionData({ abi: ERC20_ABI, data });
      if (
        decoded.functionName !== "transfer" ||
        decoded.args[0].toLowerCase() !== terms.recipient ||
        decoded.args[1].toString() !== terms.atomicAmount
      ) {
        throw new Error("ERC-20 transfer encoding did not match payment terms.");
      }
      transaction = {
        from: terms.sender,
        to: terms.tokenContract,
        value: "0x0",
        data
      };
    }

    let simulation;
    try {
      const result = await invoke(
        "eth_call",
        pin("eth_call", { transaction })
      );
      if (terms.asset === "PHRS") {
        simulation = { kind: "SUCCESS", returnData: result.result ?? null };
      } else if (!result.result || result.result === "0x") {
        simulation = { kind: "MALFORMED_RETURN" };
      } else {
        const success = decodeFunctionResult({
          abi: ERC20_ABI,
          functionName: "transfer",
          data: result.result
        });
        simulation = {
          kind: success === true ? "SUCCESS" : "ERC20_FALSE",
          returnData: result.result
        };
      }
    } catch (error) {
      simulation = toolFailure(error);
    }

    let estimate = null;
    let estimateError = null;
    try {
      const result = await invoke("estimate_gas", { transaction });
      estimate = parseBigInt(
        String(result.gas ?? result.gasEstimate ?? ""),
        "Gas estimate"
      );
    } catch (error) {
      estimateError = toolFailure(error);
    }

    const bufferedGas = estimate === null ? null : (estimate * 12000n + 9999n) / 10000n;
    const maximumGasCost = bufferedGas === null ? null : bufferedGas * gasPrice;
    const atomicAmount = BigInt(terms.atomicAmount);
    const issues = [];

    if (simulation.kind !== "SUCCESS") {
      issues.push({
        code: simulation.kind,
        message: simulation.message || "Simulation did not establish payment success."
      });
    }
    if (estimate === null || maximumGasCost === null) {
      issues.push({
        code: "GAS_UNAVAILABLE",
        message: estimateError?.message || "Gas estimate is unavailable."
      });
    }
    if (
      terms.asset === "PHRS" &&
      maximumGasCost !== null &&
      nativeBalance < atomicAmount + maximumGasCost
    ) {
      issues.push({
        code: "INSUFFICIENT_NATIVE_FUNDS",
        message: "Native balance cannot cover value plus buffered gas."
      });
    }
    if (terms.asset !== "PHRS" && tokenBalance < atomicAmount) {
      issues.push({
        code: "INSUFFICIENT_TOKEN_FUNDS",
        message: "Token balance is insufficient."
      });
    }
    if (
      terms.asset !== "PHRS" &&
      maximumGasCost !== null &&
      nativeBalance < maximumGasCost
    ) {
      issues.push({
        code: "INSUFFICIENT_GAS_FUNDS",
        message: "Native balance cannot cover buffered gas."
      });
    }

    const normalizedTerms = { ...terms, decimals, symbol };
    const paymentDigest = await termsDigest(normalizedTerms);
    const capturedAt = now.toISOString();
    const validation = {
      id: crypto.randomUUID(),
      engineVersion: ENGINE_VERSION,
      status: issues.length ? "BLOCKED" : "VALIDATED",
      terms: normalizedTerms,
      paymentDigest,
      transaction,
      simulation,
      issues,
      balances: {
        nativeWei: nativeBalance.toString(),
        tokenAtomic: tokenBalance?.toString() ?? null
      },
      gas: {
        estimate: estimate?.toString() ?? null,
        bufferedLimit: bufferedGas?.toString() ?? null,
        gasPriceWei: gasPrice.toString(),
        maximumCostWei: maximumGasCost?.toString() ?? null
      },
      observation: {
        capturedAt,
        block: String(blockNumber),
        balancePinned: supportsBlockPin(tools, "get_balance"),
        callPinned: supportsBlockPin(tools, "eth_call"),
        expiresAt: new Date(now.getTime() + LIMITS.validationTtlMs).toISOString()
      },
      trace,
      disclosure: "NOT SENT / NO SIGNATURE"
    };
    validation.validationDigest = await digest({
      paymentDigest,
      status: validation.status,
      observation: validation.observation,
      balances: validation.balances,
      gas: validation.gas,
      simulation
    });
    return validation;
  };

  return injected ? run(injected) : withChainMcp(run);
}

export async function reviewValidation(
  validation,
  accepted,
  now = new Date()
) {
  if (!accepted || validation?.status !== "VALIDATED") {
    throw Object.assign(
      new Error("A successful validation and explicit review are required."),
      { status: 409 }
    );
  }
  if (Date.parse(validation.observation.expiresAt) <= now.getTime()) {
    throw Object.assign(new Error("Validation expired."), { status: 409 });
  }
  return {
    accepted: true,
    statement: REVIEW_TEXT,
    paymentDigest: validation.paymentDigest,
    validationDigest: validation.validationDigest,
    reviewedAt: now.toISOString()
  };
}

export async function prepareUnsigned(previous, review, fresh, now = new Date()) {
  if (
    previous?.status !== "VALIDATED" ||
    fresh?.status !== "VALIDATED" ||
    !review?.accepted
  ) {
    throw Object.assign(new Error("Fresh validated review is required."), {
      status: 409
    });
  }
  if (Date.parse(previous.observation.expiresAt) <= now.getTime()) {
    throw Object.assign(new Error("Reviewed validation expired."), {
      status: 409
    });
  }
  if (
    review.paymentDigest !== previous.paymentDigest ||
    review.validationDigest !== previous.validationDigest ||
    fresh.paymentDigest !== previous.paymentDigest
  ) {
    throw Object.assign(
      new Error("Payment terms or reviewed validation changed."),
      { status: 409 }
    );
  }

  return {
    kind: "UNSIGNED_TRANSACTION",
    unsigned: true,
    signed: false,
    broadcast: false,
    paymentDigest: fresh.paymentDigest,
    preparedAt: now.toISOString(),
    transaction: {
      chainId: NETWORK.chainId,
      from: fresh.transaction.from,
      to: fresh.transaction.to,
      value: fresh.transaction.value,
      data: fresh.transaction.data,
      gas: toHex(fresh.gas.bufferedLimit)
    },
    walletMustPopulate: ["nonce", "fee fields"],
    warning: "PREPARED IS NOT PAID. Pause cannot invalidate a downloaded transaction."
  };
}

function unwrap(value, key) {
  return value?.[key] ?? value;
}

export async function reconcileOccurrence(
  occurrence,
  hash,
  injected,
  now = new Date()
) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error("Transaction hash is invalid.");
  }
  const run = async ({ call }) => {
    const chain = await call("get_chain_info", {});
    if (Number(chain.chainId) !== NETWORK.chainId) {
      throw new Error("Wrong chain.");
    }
    let transaction;
    let receipt;
    try {
      transaction = unwrap(await call("get_transaction", { hash }), "transaction");
      receipt = unwrap(
        await call("get_transaction_receipt", { hash }),
        "receipt"
      );
    } catch (error) {
      return {
        state: "RECONCILIATION_REQUIRED",
        hash,
        error: toolFailure(error),
        checkedAt: now.toISOString()
      };
    }
    if (!transaction || !receipt) {
      return {
        state: "AWAITING_CONFIRMATION",
        hash,
        checkedAt: now.toISOString(),
        reason: "Transaction or receipt is not yet available."
      };
    }
    if (
      String(receipt.transactionHash || receipt.hash).toLowerCase() !==
        hash.toLowerCase() ||
      String(transaction.hash).toLowerCase() !== hash.toLowerCase()
    ) {
      throw new Error("Transaction and receipt identities do not match.");
    }

    const expected = occurrence.unsignedTransaction.transaction;
    if (
      String(transaction.from).toLowerCase() !== expected.from ||
      String(transaction.to).toLowerCase() !== expected.to
    ) {
      throw new Error("Transaction sender or destination does not match.");
    }
    if (String(receipt.status).toLowerCase() === "0x0" || receipt.status === 0) {
      return {
        state: "FAILED_ONCHAIN",
        hash,
        checkedAt: now.toISOString(),
        receipt
      };
    }
    if (
      String(receipt.status).toLowerCase() !== "0x1" &&
      receipt.status !== 1
    ) {
      return {
        state: "AWAITING_CONFIRMATION",
        hash,
        checkedAt: now.toISOString(),
        reason: "Receipt status is unknown."
      };
    }

    if (BigInt(transaction.value || "0x0") !== BigInt(expected.value)) {
      throw new Error("Transaction value does not match.");
    }
    if (occurrence.terms.asset === "PHRS") {
      if (BigInt(transaction.value) !== BigInt(occurrence.terms.atomicAmount)) {
        throw new Error("Native payment amount does not match.");
      }
    } else {
      const decoded = decodeFunctionData({
        abi: ERC20_ABI,
        data: transaction.input || transaction.data
      });
      if (
        decoded.functionName !== "transfer" ||
        decoded.args[0].toLowerCase() !== occurrence.terms.recipient ||
        decoded.args[1].toString() !== occurrence.terms.atomicAmount
      ) {
        throw new Error("ERC-20 transfer calldata does not match.");
      }
      const matched = (receipt.logs || []).some((log) => {
        try {
          const event = decodeEventLog({
            abi: ERC20_ABI,
            data: log.data,
            topics: log.topics
          });
          return (
            event.eventName === "Transfer" &&
            String(log.address).toLowerCase() ===
              occurrence.terms.tokenContract &&
            String(event.args.from).toLowerCase() === occurrence.terms.sender &&
            String(event.args.to).toLowerCase() === occurrence.terms.recipient &&
            event.args.value.toString() === occurrence.terms.atomicAmount
          );
        } catch {
          return false;
        }
      });
      if (!matched) throw new Error("Matching ERC-20 Transfer event was not found.");
    }

    const latest = await call("get_block_number", {});
    const latestNumber = BigInt(
      latest.blockNumberHex ?? latest.blockNumber ?? latest.number
    );
    const confirmations =
      Number(latestNumber - BigInt(receipt.blockNumber) + 1n);
    if (confirmations < LIMITS.confirmations) {
      return {
        state: "AWAITING_CONFIRMATION",
        hash,
        confirmations,
        checkedAt: now.toISOString(),
        receipt
      };
    }
    return {
      state: "PAID",
      hash,
      confirmations,
      checkedAt: now.toISOString(),
      receipt
    };
  };
  return injected ? run(injected) : withChainMcp(run);
}
