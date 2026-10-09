import { rmSync } from "node:fs";

rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
rmSync(new URL("../cdn/", import.meta.url), { recursive: true, force: true });
rmSync(new URL("../reports/", import.meta.url), { recursive: true, force: true });
rmSync(new URL("../temp/api/", import.meta.url), { recursive: true, force: true });
