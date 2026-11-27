const geocoder = "https://photon.komoot.io";

async function lookup(path, params) {
  const url = new URL(path, geocoder);
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
  }
  url.searchParams.set("lang", "en");
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("Location lookup is unavailable.");
  const { features } = await response.json();
  return features.map(({ properties, geometry }) => ({ ...properties, coordinates: geometry?.coordinates })).filter(place => place?.countrycode?.toUpperCase() === "IN");
}

export async function searchLocations(query) {
  const matches = await lookup("/api/", { q: query, countrycode: "IN", layer: ["city", "district", "locality"], limit: 12 });
  const unique = new Map();
  for (const place of matches) {
    const name = place.name || place.locality || place.district || place.city;
    if (!name) continue;
    const context = [...new Set([place.district, place.city, place.county, place.state])]
      .filter(part => part && part.toLowerCase() !== name.toLowerCase()).join(", ");
    const [longitude, latitude] = place.coordinates ?? [];
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) unique.set(name + "|" + context, { name, context, latitude, longitude });
  }
  return [...unique.values()];
}

export async function currentLocality(geolocation = navigator.geolocation) {
  if (!geolocation) throw new Error("Device location is unavailable. Search for a location instead.");
  const { coords } = await new Promise((resolve, reject) => geolocation.getCurrentPosition(
    resolve,
    error => reject(new Error(error.code === 1
      ? "Location permission denied. Search for a location instead."
      : "Could not get your device location. Search for a location instead.")),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  ));
  const matches = await lookup("/reverse", { lat: coords.latitude, lon: coords.longitude, limit: 1 });
  const place = matches[0];
  const name = place && (
    (["locality", "district"].includes(place.type) && place.name) ||
    place.locality || place.district || place.city ||
    (place.type === "city" && place.name)
  );
  if (!name) throw new Error("Could not identify your locality in India. Search for a location instead.");
  return { name, latitude: coords.latitude, longitude: coords.longitude };
}
