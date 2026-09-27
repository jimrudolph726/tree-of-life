type RumEventData = Record<string, boolean | number | string>;
type RumClient = { recordEvent: (eventType: string, eventData: object) => void };

const applicationId = import.meta.env.VITE_RUM_APP_MONITOR_ID?.trim();
const region = import.meta.env.VITE_RUM_REGION?.trim() || 'us-east-1';
const releaseId = import.meta.env.VITE_RELEASE_ID?.trim() || 'development';
const queuedEvents: Array<[string, RumEventData]> = [];
let client: RumClient | null = null;

function emit(eventType: string, eventData: RumEventData) {
  try {
    client?.recordEvent(eventType, eventData);
  } catch {
    // Monitoring must never interfere with navigation or rendering.
  }
}

export function startRum() {
  if (!applicationId || typeof window === 'undefined') return;
  void import('@aws-rum/web-slim').then(({ AwsRum, FetchPlugin, JsErrorPlugin, NavigationPlugin,
    ResourcePlugin, WebVitalsPlugin, XhrPlugin }) => {
    client = new AwsRum(applicationId, releaseId, region, {
      allowCookies: false,
      endpoint: `https://dataplane.rum.${region}.amazonaws.com`,
      eventPluginsToLoad: [
        new JsErrorPlugin(),
        new NavigationPlugin(),
        new ResourcePlugin({ eventLimit: 10 }),
        new WebVitalsPlugin(),
        new FetchPlugin(),
        new XhrPlugin(),
      ],
      sessionSampleRate: 0.05,
    });
    for (const [eventType, eventData] of queuedEvents.splice(0)) emit(eventType, eventData);
  }).catch(() => {
    queuedEvents.length = 0;
  });
}

export function recordRumEvent(eventType: string, eventData: RumEventData) {
  if (!applicationId) return;
  if (client) emit(eventType, eventData);
  else if (queuedEvents.length < 20) queuedEvents.push([eventType, eventData]);
}
