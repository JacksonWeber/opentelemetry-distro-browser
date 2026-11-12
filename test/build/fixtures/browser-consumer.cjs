const {
  OPENTELEMETRY_BROWSER_VERSION,
  useMicrosoftOpenTelemetry,
} = require("@microsoft/opentelemetry-browser");
const { createTelemetryDebugger } = require("@microsoft/opentelemetry-browser/debug");

module.exports = {
  OPENTELEMETRY_BROWSER_VERSION,
  useMicrosoftOpenTelemetry,
  createTelemetryDebugger,
};
