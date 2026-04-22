import { type BenchmarkResult } from "./cli.js";
import {
  runReconnectStormScenario,
  runSingleNodeRoomScenario,
} from "./scenarios.js";

function readRequiredPositiveNumber(
  command: Record<string, number | string>,
  key: string,
): number {
  const rawValue = command[key];
  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid numeric command value for ${key}: ${String(rawValue)}`,
    );
  }

  return parsed;
}

export async function runCiScenario(
  scenario: string,
  command: Record<string, number | string>,
): Promise<BenchmarkResult> {
  if (scenario === "single-node-room") {
    return runSingleNodeRoomScenario({
      memberCount: readRequiredPositiveNumber(command, "memberCount"),
      durationSeconds: readRequiredPositiveNumber(command, "durationSeconds"),
      updatesPerSecond: readRequiredPositiveNumber(command, "updatesPerSecond"),
      watcherCount: readRequiredPositiveNumber(command, "sampledWatchers"),
    });
  }

  if (scenario === "reconnect-storm") {
    return runReconnectStormScenario({
      memberCount: readRequiredPositiveNumber(command, "memberCount"),
      reconnectTimeoutMs: readRequiredPositiveNumber(
        command,
        "reconnectTimeoutMs",
      ),
    });
  }

  throw new Error(`Unsupported CI benchmark scenario: ${scenario}`);
}
