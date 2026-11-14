import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/worker.mjs" with { type: "cf-worker" };

const localDatabaseId = "00000000-0000-4000-8000-000000000001";

export default defineConfig(({ mode }) => {
  const databaseId =
    mode === "production"
      ? process.env.CLOUDFLARE_D1_DATABASE_ID
      : localDatabaseId;

  return {
    worker: {
      name: "recurring-payment-agent",
      domains: ["recurring-payment.nampharos.web.id"],
      compatibilityDate: "2026-11-14",
      entrypoint,
      env: {
        DB: bindings.d1({
          name: "recurring-payment-agent",
          ...(databaseId ? { id: databaseId } : {})
        }),
        ASSETS: bindings.assets()
      },
      triggers: [triggers.scheduled({ schedule: "* * * * *" })],
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: true, headSamplingRate: 1 },
        traces: { enabled: true, headSamplingRate: 0.1 }
      }
    }
  };
});
