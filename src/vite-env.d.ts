/// <reference types="vite/client" />

declare module '*.css';

interface ImportMetaEnv {
  readonly VITE_RELEASE_ID?: string;
  readonly VITE_RUM_APP_MONITOR_ID?: string;
  readonly VITE_RUM_REGION?: string;
}
