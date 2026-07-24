import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Relative asset paths for the production build so it works when served from a
  // subpath (GitHub Pages project site: https://<owner>.github.io/<repo>/) without
  // hardcoding the repo name. Dev server stays at '/' for clean HMR.
  base: command === 'build' ? './' : '/',
}))
