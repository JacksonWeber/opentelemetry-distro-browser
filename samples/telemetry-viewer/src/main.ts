import "./style.css";
import { initializeTelemetry } from "./telemetry.js";
import { startTelemetryViewer } from "./telemetryViewer.js";

const telemetry = await initializeTelemetry();
startTelemetryViewer();

const { startApplication } = await import("./app.js");
startApplication(telemetry);
