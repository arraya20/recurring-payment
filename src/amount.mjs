export function validateDecimalAmount(value) {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
  ) {
    throw new Error("Amount must be a plain positive decimal string.");
  }
  const [whole, fraction = ""] = value.split(".");
  if (BigInt(whole) === 0n && !/[1-9]/.test(fraction)) {
    throw new Error("Amount must be greater than zero.");
  }
  return value;
}

export function parseUnitsExact(value, decimals) {
  validateDecimalAmount(value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Token decimals must be between 0 and 255.");
  }

  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Amount exceeds token precision of ${decimals} decimals.`);
  }

  const atomic =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (atomic <= 0n) throw new Error("Amount must be greater than zero.");
  return atomic;
}

export function toHex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

export function parseBigInt(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is unavailable.`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${label} is malformed.`);
  }
}
