declare module "*.js?raw" {
  const source: string;
  export default source;
}

declare module "*dist/esm/index.js" {
  export const useMicrosoftOpenTelemetry: typeof import("../src/index.js").useMicrosoftOpenTelemetry;
}

declare module "*dist/esm/index.min.js" {
  export const useMicrosoftOpenTelemetry: typeof import("../src/index.js").useMicrosoftOpenTelemetry;
}
