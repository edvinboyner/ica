import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";

const root = new URL(".", import.meta.url).pathname;

// Plugin to copy manifest.json and icons after build
function copyExtensionFiles() {
  return {
    name: "copy-extension-files",
    writeBundle() {
      // Copy manifest and icons
      mkdirSync(`${root}dist/icons`, { recursive: true });
      copyFileSync(`${root}manifest.json`, `${root}dist/manifest.json`);
      for (const size of [16, 48, 128]) {
        copyFileSync(
          `${root}public/icons/icon${size}.png`,
          `${root}dist/icons/icon${size}.png`
        );
      }

      // Move popup HTML from dist/src/popup/index.html -> dist/popup/index.html
      // and fix asset paths inside it
      const srcHtml = `${root}dist/src/popup/index.html`;
      const dstDir = `${root}dist/popup`;
      mkdirSync(dstDir, { recursive: true });
      let html = readFileSync(srcHtml, "utf8");
      // Vite outputs paths relative to its own input location (src/popup/).
      // We move the HTML one level up (to dist/popup/), so fix references:
      // ../../popup.js     -> ../popup.js
      // ../../popup/popup.css -> ./popup.css
      html = html.replace(/src="\.\.\/\.\.\/popup\.js"/g, 'src="../popup.js"');
      html = html.replace(/href="\.\.\/\.\.\/popup\/popup\.css"/g, 'href="./popup.css"');
      writeFileSync(`${dstDir}/index.html`, html);

      // Remove the Vite-generated HTML artifact (wrong path)
      try {
        rmSync(`${root}dist/src`, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), copyExtensionFiles()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "src/popup/index.html"),
        "content/content": resolve(__dirname, "src/content/content.ts"),
        "background/service-worker": resolve(
          __dirname,
          "src/background/service-worker.ts"
        ),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css")) return "popup/[name][extname]";
          return "assets/[name][extname]";
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
