import { spawnSync } from "node:child_process";

const argumentsForUv = process.argv.slice(2);
const uvProbe = spawnSync("uv", ["--version"], { stdio: "ignore" });
const command = uvProbe.status === 0 ? "uv" : "python3";
const args = command === "uv" ? argumentsForUv : ["-m", "uv", ...argumentsForUv];
const result = spawnSync(command, args, { stdio: "inherit", env: process.env });

if (result.error) {
  process.stderr.write(`Unable to run uv: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
