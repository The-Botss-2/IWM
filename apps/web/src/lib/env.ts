export const env = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
  apiBasePath: process.env.NEXT_PUBLIC_API_BASE_PATH ?? '/api/v1',
  /**
   * Public origin of the web app. Used by `metadataBase` so Next.js can
   * resolve Open Graph and Twitter image URLs to absolute links. Override
   * in production with the deployed origin (e.g. https://app.example.com).
   */
  webUrl: process.env.NEXT_PUBLIC_WEB_URL ?? 'http://localhost:3000',
};
