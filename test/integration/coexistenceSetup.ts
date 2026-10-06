// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { fileURLToPath } from "node:url";
import { copyFile } from "node:fs/promises";
import webpack, { type Configuration } from "webpack";
import packageJson from "../../package.json" with { type: "json" };

/** Build real federation hosts and remotes, with shared and separately bundled OTel APIs. */
export default async function setup(): Promise<void> {
  const { peerDependencies, dependencies } = packageJson;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const configs: Configuration[] = [];
  for (const mode of ["shared", "isolated", "runtime-patch"]) {
    const shared: ConstructorParameters<
      typeof webpack.container.ModuleFederationPlugin
    >[0]["shared"] =
      mode === "shared"
        ? {
            "@opentelemetry/api": {
              singleton: true,
              eager: true,
              requiredVersion: peerDependencies["@opentelemetry/api"],
            },
            "@opentelemetry/api-logs": {
              singleton: true,
              eager: true,
              requiredVersion: dependencies["@opentelemetry/api-logs"],
            },
          }
        : {};
    for (const side of ["host", "remote"]) {
      configs.push({
        mode: "development",
        devtool: false,
        context: root,
        target: ["web", "es2022"],
        entry: side === "host" ? "./test/fixtures/coexistenceHost.mjs" : {},
        experiments: { outputModule: true },
        output: {
          path: fileURLToPath(new URL(`../../reports/coexistence/${mode}/`, import.meta.url)),
          filename: "host.mjs",
          chunkFilename: "[name].[contenthash].mjs",
          chunkLoading: "import",
          publicPath: "auto",
          library: { type: "module" },
          uniqueName: `coexistence-${mode}-${side}`,
        },
        plugins: [
          ...(mode === "runtime-patch"
            ? [
                new webpack.NormalModuleReplacementPlugin(
                  /[\\/]api[\\/]build[\\/]esm[\\/]version\.js$/,
                  fileURLToPath(new URL("../fixtures/coexistenceApiVersion.mjs", import.meta.url)),
                ),
              ]
            : []),
          new webpack.container.ModuleFederationPlugin({
            name: `coexistence_${mode}_${side}`,
            library: { type: "module" },
            shared,
            ...(side === "host"
              ? {
                  remoteType: "module",
                  remotes: { coexistenceRemote: "./remoteEntry.mjs" },
                }
              : {
                  filename: "remoteEntry.mjs",
                  exposes: { "./telemetry": "./test/fixtures/coexistenceEntry.mjs" },
                }),
          }),
        ],
      });
    }
  }
  const compiler = webpack(configs);
  if (!compiler) throw new Error("Could not create coexistence fixture compiler");
  try {
    await new Promise<void>((resolve, reject) => {
      compiler.run((error, stats) => {
        if (error) reject(error);
        else if (!stats || stats.hasErrors()) {
          reject(new Error(stats?.toString({ all: false, errors: true }) ?? "No webpack stats"));
        } else resolve();
      });
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      compiler.close((error) => (error ? reject(error) : resolve()));
    });
  }
  // Serve the realm entry unchanged, without Vitest's test-frame dynamic-import runtime.
  await copyFile(
    new URL("../fixtures/coexistenceRealm.mjs", import.meta.url),
    new URL("../../reports/coexistence/realm.mjs", import.meta.url),
  );
}
