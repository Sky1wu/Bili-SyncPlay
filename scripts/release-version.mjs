import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const nextVersion = process.argv[2]?.trim();

if (!nextVersion) {
  console.error("Usage: npm run release:version -- <version>");
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(nextVersion)) {
  console.error(`Invalid version: ${nextVersion}`);
  process.exit(1);
}

const packagePaths = [
  path.join(rootDir, "package.json"),
  path.join(rootDir, "packages", "protocol", "package.json"),
  path.join(rootDir, "server", "package.json"),
  path.join(rootDir, "extension", "package.json")
];

for (const packagePath of packagePaths) {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.version = nextVersion;

  if (packageJson.dependencies?.["@bili-syncplay/protocol"]) {
    packageJson.dependencies["@bili-syncplay/protocol"] = nextVersion;
  }

  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

if (process.platform === "win32") {
  await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm install --package-lock-only"], rootDir);
} else {
  await run("npm", ["install", "--package-lock-only"], rootDir);
}

console.log(`Updated workspace version to ${nextVersion}`);

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: false
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}
