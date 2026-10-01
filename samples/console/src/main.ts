import "./style.css";
import { initializeTelemetry } from "./telemetry.js";

await initializeTelemetry();
await import("./app.js");
