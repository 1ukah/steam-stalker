const { SteamStalkerApp } = require("./lib/app");

async function main() {
  const watcher = new SteamStalkerApp();
  await watcher.run();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
