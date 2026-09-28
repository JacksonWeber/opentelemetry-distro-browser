import "./style.css";
import { initializeTelemetry } from "./telemetry.js";

try {
  const telemetry = await initializeTelemetry();
  const { startApplication } = await import("./app.js");
  startApplication(telemetry);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  document.body.textContent = `Telemetry setup failed: ${message}`;
  throw error;
}
