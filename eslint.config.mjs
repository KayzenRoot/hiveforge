import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const filename = fileURLToPath(import.meta.url);
const directory = dirname(filename);
const compat = new FlatCompat({ baseDirectory: directory });

const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: ["next-env.d.ts", ".next/**", "node_modules/**", ".protocol-inspect/**", "data/**", "review/**"]
  }
];

export default config;
