import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  if (mode === 'production' && env.VITE_DEEPSEEK_API_KEY) {
    throw new Error(
      'Refusing to build: VITE_DEEPSEEK_API_KEY would be embedded in the public client bundle. ' +
        'Enter the key in the app at runtime or use a backend proxy.',
    )
  }
  const basePath = env.VITE_BASE_PATH?.trim() || '/'
  const base = basePath === '/' ? '/' : `${basePath.replace(/\/+$/, '')}/`

  return {
    base,
    plugins: [vue()],
  }
})

