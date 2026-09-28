import "./style.css";
import { initializeTelemetry } from "./telemetry.js";

try {
  await initializeTelemetry();
  await import("./app.js");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  document.body.innerHTML = `<main><h1>Telemetry setup failed</h1><p>${message}</p></main>`;
  throw error;
}
