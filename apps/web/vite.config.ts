import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const allowedHosts = (process.env.PI_WEB_ALLOWED_HOSTS ?? process.env.PI_WEB_VITE_ALLOWED_HOSTS ?? '.ts.net')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean)

const enableHmr = process.env.PI_WEB_VITE_HMR === 'true'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    allowedHosts,
    hmr: enableHmr ? undefined : false,
    watch: {
      ignored: ['**/.bakery/**', '**/test-results/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
