import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // 云端图像中继地址在构建期写入主进程；Key 不再随构建产物分发，
    // 2026-10-21 起默认是设备面自己的域名 pi-studio.glanger.xyz（trail-api.glanger.xyz 仍兼容，
    // 设置里填了旧地址的照样能用）。
    // 由设置页的加密配置或开发环境 PI_CLOUD_IMAGE_KEY 提供。
    define: {
      __CLOUD_IMAGE_RELAY__: JSON.stringify(
        process.env.PI_CLOUD_IMAGE_RELAY || 'https://pi-studio.glanger.xyz',
      ),
      __TRAILAI_API_URL__: JSON.stringify(
        process.env.PI_STUDIO_SYNC_URL || 'https://pi-studio.glanger.xyz',
      ),
    },
    resolve: {
      alias: { '@main': resolve('src/main') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src'),
      },
    },
  },
})
