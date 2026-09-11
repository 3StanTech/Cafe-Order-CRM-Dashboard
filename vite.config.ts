import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { sentryVitePlugin } from '@sentry/vite-plugin'

// Presence check only — read the variable name to decide whether to enable the
// plugin. Never log, never write, never embed SENTRY_AUTH_TOKEN in client code.
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN
const sentryEnabled = typeof sentryAuthToken === 'string' && sentryAuthToken.trim() !== ''

function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined

  // React ecosystem — keep router with the framework runtime.
  if (
    id.includes('node_modules/react-dom') ||
    id.includes('node_modules/react-router') ||
    id.includes('node_modules/scheduler') ||
    /node_modules\/react\//.test(id)
  ) {
    return 'framework'
  }

  // Supabase client and its scoped packages.
  if (id.includes('node_modules/@supabase/')) {
    return 'supabase'
  }

  return undefined
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'],
      devOptions: {
        enabled: true,
        type: 'module',
      },
      manifest: {
        name: 'Gelly Dashboard',
        short_name: 'Gelly',
        description: 'Mobile-first order management for a Metro Manila matcha cafe.',
        theme_color: '#4F74C8',
        background_color: '#FBF3D5',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
    // Only register when SENTRY_AUTH_TOKEN is present (Netlify build with secrets).
    // Org/project come from env — never hardcoded. Hidden maps are uploaded then deleted.
    ...(sentryEnabled
      ? [
          sentryVitePlugin({
            org: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT,
            authToken: sentryAuthToken,
            sourcemaps: {
              filesToDeleteAfterUpload: ['./dist/**/*.map'],
            },
          }),
        ]
      : []),
  ],
  // Hidden source maps only when the upload plugin is active (then deleted post-upload).
  // Without the token, build behaviour matches today: no sourcemap emission.
  build: {
    ...(sentryEnabled ? { sourcemap: 'hidden' as const } : {}),
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    globals: true,
    env: {
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
    },
  },
  server: process.env.LOCAL_ORDER_FUNCTIONS_URL
    ? {
        proxy: {
          '/.netlify/functions': {
            target: process.env.LOCAL_ORDER_FUNCTIONS_URL,
            changeOrigin: true,
          },
        },
      }
    : undefined,
})
