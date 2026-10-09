// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** Loads an emitted browser bundle without a second bundler or Vite transformation. */
export async function loadBrowserScript(file: string): Promise<HTMLScriptElement> {
  const script = document.createElement("script");
  const path = `../../dist/browser/${file}`;
  script.src = new URL(path, import.meta.url).href;
  const loaded = new Promise<void>((resolve, reject) => {
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error(`Failed to load ${file}`)), {
      once: true,
    });
  });
  document.head.append(script);
  try {
    await loaded;
    return script;
  } catch (error) {
    script.remove();
    throw error;
  }
}
