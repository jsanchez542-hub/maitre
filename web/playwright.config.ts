import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    // A port of its own: 4321 is where astro dev or a preview runs for people to look at, live against the Worker.
    baseURL: 'http://localhost:4322',
    // Chromium's fake microphone, for the call to the restaurant: a page that asks for it gets a tone, never a device.
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'] } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // Alongside any preview already running for people to look at, which Astro would otherwise refuse.
    command: 'npm run preview -- --port 4322 --ignore-lock',
    url: 'http://localhost:4322',
    reuseExistingServer: !process.env['CI'],
  },
});
