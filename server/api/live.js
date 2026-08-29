/**
 * Live data integrations used by the operations console.
 *
 * Weather comes from Open-Meteo's public current-weather endpoint. The request is
 * deliberately server-side, cached, bounded by a timeout, and backed by a stable
 * fallback so the offline demo never fails when the network is unavailable.
 */

const MUMBAI = { lat: 19.076, lng: 72.8777, timezone: 'Asia/Kolkata' };
const CACHE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3500;
let cached = null;

const WMO = {
  0: ['Clear', 'clear'],
  1: ['Mainly clear', 'clear'], 2: ['Partly cloudy', 'cloudy'], 3: ['Overcast', 'cloudy'],
  45: ['Fog', 'cloudy'], 48: ['Rime fog', 'cloudy'],
  51: ['Light drizzle', 'rain'], 53: ['Drizzle', 'rain'], 55: ['Heavy drizzle', 'rain'],
  61: ['Light rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy rain', 'heavy_rain'],
  71: ['Light snow', 'cloudy'], 73: ['Snow', 'cloudy'], 75: ['Heavy snow', 'cloudy'],
  80: ['Rain showers', 'rain'], 81: ['Rain showers', 'rain'], 82: ['Heavy showers', 'heavy_rain'],
  95: ['Thunderstorm', 'heavy_rain'], 96: ['Thunderstorm with hail', 'heavy_rain'],
  99: ['Thunderstorm with hail', 'heavy_rain'],
};

function fallback() {
  return {
    live: false,
    source: 'offline-fallback',
    location: 'Mumbai',
    latitude: MUMBAI.lat,
    longitude: MUMBAI.lng,
    temperatureC: null,
    windKmph: null,
    precipitationMm: null,
    weatherCode: null,
    condition: 'Live weather unavailable',
    weather: 'rain',
    fetchedAt: new Date().toISOString(),
  };
}

export async function getLiveWeather() {
  if (cached && Date.now() - cached.cachedAt < CACHE_MS) return { ...cached.data, cached: true };

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: String(MUMBAI.lat), longitude: String(MUMBAI.lng),
    current: 'temperature_2m,weather_code,wind_speed_10m,precipitation',
    timezone: MUMBAI.timezone,
  });

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`weather provider returned ${response.status}`);
    const body = await response.json();
    const current = body?.current;
    const code = Number(current?.weather_code);
    if (!current || !Number.isFinite(code)) throw new Error('weather provider returned no current conditions');
    const [condition, weather] = WMO[code] ?? ['Unknown conditions', 'cloudy'];
    const data = {
      live: true,
      source: 'open-meteo',
      location: 'Mumbai',
      latitude: MUMBAI.lat,
      longitude: MUMBAI.lng,
      temperatureC: Number.isFinite(Number(current.temperature_2m)) ? Number(current.temperature_2m) : null,
      windKmph: Number.isFinite(Number(current.wind_speed_10m)) ? Number(current.wind_speed_10m) : null,
      precipitationMm: Number.isFinite(Number(current.precipitation)) ? Number(current.precipitation) : null,
      weatherCode: code,
      condition,
      weather,
      fetchedAt: new Date().toISOString(),
    };
    cached = { data, cachedAt: Date.now() };
    return data;
  } catch {
    const data = fallback();
    cached = { data, cachedAt: Date.now() };
    return data;
  }
}

export function __resetLiveCache() { cached = null; }
