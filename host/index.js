import { buildUsageReport } from "./report.js";

const HOST_VERSION = "0.0.0-m5";

async function main() {
  const report = await buildUsageReport(HOST_VERSION);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main();
