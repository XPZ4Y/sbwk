import { z } from "zod";
import { ServiceName } from "../types";
import { inspectService, serviceChecks } from "../adapters/service.adapters";
import { toolDefinitions } from "../registry/tool.registry";
import { config } from "../config";

export const executeSchema = z.object({
  tool: z.string().min(1).max(100),
  arguments: z.record(z.unknown()).optional().default({})
}).strict();

export const investigateSchema = z.object({
  services: z.array(z.enum(["server", "database", "auth", "external_api", "codebase", "cicd"])).min(1).max(6)
}).strict();

export async function executeTool(input: z.infer<typeof executeSchema>) {
  const definition = toolDefinitions.find(item => item.name === input.tool);
  if (!definition) {
    return { success: false as const, error: { code: "UNKNOWN_TOOL", message: "Tool is not registered" } };
  }

  if (Object.keys(input.arguments).length > 0) {
    return { success: false as const, error: { code: "INVALID_ARGUMENTS", message: "This diagnostic tool accepts no arguments" } };
  }

  const check = definition.name.replace(`inspect_${definition.service}_`, "");
  const result = await inspectService(definition.service, check);

  return { success: true as const, result };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function investigateServices(services: ServiceName[]) {
  const checks = services.flatMap(service => serviceChecks[service].map(check => ({ service, check })));
  const results = await mapLimit(checks, config.MAX_BATCH_CONCURRENCY, ({ service, check }) =>
    inspectService(service, check)
  );

  return {
    requestId: undefined,
    observedAt: new Date().toISOString(),
    results,
    summary: {
      total: results.length,
      healthy: results.filter(item => item.status === "healthy").length,
      degraded: results.filter(item => item.status === "degraded").length,
      unhealthy: results.filter(item => item.status === "unhealthy").length,
      unreachable: results.filter(item => item.status === "unreachable").length,
      unknown: results.filter(item => item.status === "unknown").length
    }
  };
}
