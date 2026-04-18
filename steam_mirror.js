const { SteamMirrorApp } = require("./lib/app");

async function main() {
  const watcher = new SteamMirrorApp();
  await watcher.run();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
