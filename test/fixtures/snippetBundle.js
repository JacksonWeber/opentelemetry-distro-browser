globalThis.Microsoft = {
  OpenTelemetry: {
    useMicrosoftOpenTelemetry: function (options) {
      globalThis.snippetOptions = options;
      return Promise.resolve({
        forceFlush: function () {},
      });
    },
  },
};
