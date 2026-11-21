import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    "./src/{index,cli}.ts",
  ],
  clean: true,
  format: ["esm"],
  dts: false,
  minify: false,
  shims: true
})