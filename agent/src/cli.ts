#!/usr/bin/env node
import { addRepository, listRepositories, removeRepository } from "./config.js";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const args = argv.filter(arg => arg !== "--json");
function present(result: unknown) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (typeof result === "string") console.log(result);
  else console.log(JSON.stringify(result, null, 2));
}
async function run() {
  const [command, value] = args;
  switch (command) {
    case "add":
      present({ added: true, repository: await addRepository(value ?? ".") }); break;
    case "remove":
      present({ removed: await removeRepository(value ?? ".") }); break;
    case "list":
      present({ repositories: await listRepositories() }); break;
    case "status": {
      try {
        const response = await fetch("http://127.0.0.1:" +
          (process.env.PRISMO_PORT ?? "3000") + "/health",
          { signal: AbortSignal.timeout(1500) });
        const health = response.ok
          ? await response.json() as { service?: string; status?: string } : null;
        present({ running: health?.service === "Prismo" && health?.status === "ok",
          repositories: (await listRepositories()).length });
      } catch {
        present({ running: false, repositories: (await listRepositories()).length });
      }
      break;
    }
    default:
      present("Prismo CLI\n" +
        "  prismo add [path] [--json]\n" +
        "  prismo remove [path-or-id] [--json]\n" +
        "  prismo list [--json]\n" +
        "  prismo status [--json]\n" +
        "  기기 연결 QR은 PC 앱에서만 생성할 수 있습니다.");
  }
}
run().catch(error => {
  console.error("Prismo: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
