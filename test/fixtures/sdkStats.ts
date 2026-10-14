// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export const SDK_STATS_ENDPOINT = "https://data.stats.monitor.azure.com/v2/track";

/** Keep emitted-bundle tests local unless they explicitly exercise SDK stats delivery. */
export function withoutSdkStats(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return (url, init) =>
    url === SDK_STATS_ENDPOINT ? Promise.resolve(new Response(null)) : fetch(url, init);
}
