import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  fixedExtension: false,
  dts: false,
  clean: true,
  sourcemap: true,
  platform: "node",
  target: "node24",
  banner: { js: "#!/usr/bin/env node" },
});
