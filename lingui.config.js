import { defineConfig } from "@lingui/cli";

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "cs"], // Add or remove locales as needed
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      include: ["src"], // Or your specific source directory
    },
  ],
  format: "po", // Or your preferred format
}); 