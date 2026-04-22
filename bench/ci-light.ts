import process from "node:process";
import {
  parseCliOptions,
  readStringOption,
  type BenchmarkResult,
} from "./lib/cli.js";
import {
  compareBenchmarkToBaseline,
  loadCiBenchmarkBaseline,
  renderCiBenchmarkSummary,
  writeCiBenchmarkArtifacts,
  type CiBenchmarkComparison,
} from "./lib/ci-baseline.js";
import { runCiScenario } from "./lib/ci-light-runner.js";

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  const baselinePath = readStringOption(
    options,
    "baseline",
    "bench/ci-light-baseline.json",
  );
  const outputDir = readStringOption(options, "output-dir", ".tmp/bench-ci");

  if (!baselinePath || !outputDir) {
    throw new Error("Both baselinePath and outputDir must be defined.");
  }

  const baseline = await loadCiBenchmarkBaseline(baselinePath);
  const results: BenchmarkResult[] = [];
  const comparisons: CiBenchmarkComparison[] = [];

  for (const scenario of baseline.scenarios) {
    const result = await runCiScenario(scenario.scenario, scenario.command);
    results.push(result);
    comparisons.push(
      compareBenchmarkToBaseline({ baseline: scenario, result }),
    );
  }

  await writeCiBenchmarkArtifacts({
    outputDir,
    baselinePath,
    results,
    comparisons,
  });
  process.stdout.write(renderCiBenchmarkSummary({ comparisons, baselinePath }));

  const failedComparison = comparisons.find(
    (comparison) => comparison.passed === false,
  );
  if (failedComparison) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
});
