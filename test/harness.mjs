let passed = 0;
let failed = 0;
const failures = [];

export function show(value) {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
}

export function test(name, fn) {
  return { name, fn };
}

export function assert(cond, message) {
  if (!cond) throw new Error(message ?? "assertion failed");
}

export function equal(actual, expected, message) {
  const a = typeof actual === "bigint" ? `${actual}n` : show(actual);
  const e = typeof expected === "bigint" ? `${expected}n` : show(expected);
  if (actual !== expected) {
    throw new Error(`${message ?? "not equal"}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

export function throws(fn, match, message) {
  try {
    fn();
  } catch (e) {
    if (match && !String(e.message).includes(match)) {
      throw new Error(`${message ?? "wrong error"}: got "${e.message}"`);
    }
    return;
  }
  throw new Error(`${message ?? "expected a throw"}, but nothing was thrown`);
}

export async function run(tests) {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ok   ${t.name}`);
    } catch (e) {
      failed++;
      failures.push({ name: t.name, message: e.message });
      console.log(`  FAIL ${t.name}`);
      console.log(`       ${e.message.split("\n").join("\n       ")}`);
    }
  }

  console.log("");
  if (failed > 0) {
    console.log(`${failed} failed, ${passed} passed`);
    for (const f of failures) console.log(`  - ${f.name}`);
    process.exitCode = 1;
  } else {
    console.log(`all ${passed} tests passed`);
  }
  return failed === 0;
}
