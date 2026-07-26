import { defineConfig, type Plugin } from 'vite';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Generates the service-worker precache manifest at build time.
 *
 * We hand-roll this instead of pulling in vite-plugin-pwa: the whole plugin is ~1MB of
 * dev dependency and a Workbox runtime we don't need. Our caching story is simple —
 * precache the entire app shell (it's small and fully static), serve cache-first, and
 * bump a version string on every build. That's ~60 lines of service worker we fully
 * control, versus a black box.
 */
function pwaPlugin(): Plugin {
  let outDir = 'dist';
  return {
    name: 'pulse-pwa',
    apply: 'build',
    configResolved(cfg) {
      outDir = cfg.build.outDir;
    },
    // Runs after the bundle is written so we can see the final hashed filenames.
    closeBundle() {
      const root = process.cwd();
      const dist = resolve(root, outDir);
      const swSrc = resolve(root, 'src/pwa/sw.js');

      // Walk the build output rather than reading the Vite manifest. The app is small
      // and entirely static, so "precache everything we shipped" is both correct and
      // impossible to get subtly wrong — the manifest approach silently missed the
      // worker chunk and every file copied from public/.
      const walk = (dir: string): string[] => {
        const out: string[] = [];
        for (const entry of readdirSync(dir)) {
          if (entry === '.vite' || entry === 'sw.js') continue;
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) out.push(...walk(full));
          else out.push(relative(dist, full).split(/[\\/]/).join('/'));
        }
        return out;
      };

      // Relative URLs, so the worker resolves them against its own scope. Absolute
      // paths would break any deployment under a subdirectory — which is exactly what
      // a GitHub Pages project site is.
      const assets = ['./', ...walk(dist).map((f) => `./${f}`)];

      const version = `pulse-${Date.now().toString(36)}`;
      const sw = readFileSync(swSrc, 'utf8')
        .replace('__PRECACHE_MANIFEST__', JSON.stringify([...new Set(assets)]))
        .replace('__CACHE_VERSION__', JSON.stringify(version));
      writeFileSync(resolve(dist, 'sw.js'), sw);
    },
  };
}

export default defineConfig({
  // Relative base so the build also works from a subdirectory (GitHub Pages project
  // sites) or straight off the filesystem.
  base: './',
  build: {
    target: 'es2022',
    manifest: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // Keep the worker in its own predictable chunk.
        manualChunks: undefined,
      },
    },
  },
  worker: {
    format: 'es',
  },
  plugins: [pwaPlugin()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as never);
