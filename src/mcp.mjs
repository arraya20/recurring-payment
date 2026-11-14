import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NETWORK } from "./constants.mjs";

function parseToolResult(result, tool) {
  if (result?.isError) {
    const text = result.content?.find((item) => item.type === "text")?.text;
    throw new Error(text || `${tool} failed.`);
  }
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`${tool} returned no JSON response.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${tool} returned malformed JSON.`);
  }
}

export async function withChainMcp(run) {
  const client = new Client({
    name: "recurring-payment-agent",
    version: ENGINE_VERSION
  });
  const transport = new StreamableHTTPClientTransport(new URL(NETWORK.mcpUrl), {
    fetch: (url, init) =>
      fetch(url, { ...init, signal: AbortSignal.timeout(20000) })
  });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = listed.tools.map(({ name, inputSchema }) => ({
      name,
      inputSchema
    }));
    return await run({
      tools,
      call: async (name, args = {}) =>
        parseToolResult(
          await client.callTool({ name, arguments: args }),
          name
        )
    });
  } finally {
    try {
      await transport.terminateSession();
    } finally {
      await client.close();
    }
  }
}

import { ENGINE_VERSION } from "./constants.mjs";
