import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"types/index": "src/types/index.ts"
	},
	format: ["cjs", "esm"],
	dts: true,
	clean: true,
	splitting: false,
	treeshake: true
});
