import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "dist");
const distAssetsDir = path.join(distDir, "assets");
const rootAssetsDir = path.join(rootDir, "assets");
const pagesDir = path.join(rootDir, ".pages-build");

const ensureDistExists = async () => {
  try {
    await readdir(distDir);
  } catch {
    throw new Error("dist klasoru bulunamadi. Once `npm run build` calistir.");
  }
};

const resetPagesAssets = async () => {
  const targetAssetsDir = path.join(pagesDir, "assets");
  await rm(targetAssetsDir, { recursive: true, force: true });
  await mkdir(targetAssetsDir, { recursive: true });
  await cp(distAssetsDir, targetAssetsDir, { recursive: true });
};

const syncPagesFiles = async () => {
  await mkdir(pagesDir, { recursive: true });
  await cp(path.join(distDir, "index.html"), path.join(pagesDir, "index.html"), { force: true });

  for (const fileName of ["favicon.svg", "icons.svg"]) {
    const sourcePath = path.join(distDir, fileName);
    try {
      await cp(sourcePath, path.join(pagesDir, fileName), { force: true });
    } catch {
      // optional static files
    }
  }
};

await ensureDistExists();
await resetPagesAssets();
await syncPagesFiles();

console.log("GitHub Pages dosyalari .pages-build klasorune senkronlandi.");
