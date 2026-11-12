import { createApp } from "./app";
import { config } from "./config";

const app = createApp();
const server = app.listen(config.PORT, () => {
  console.log(`Sleepy Bot Agent Connector listening on port ${config.PORT}`);
  console.log(`Mode: ${config.CONNECTOR_MODE}`);
});

function shutdown(signal: string) {
  console.log(`${signal} received; shutting down connector`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
