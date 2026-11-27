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
      ? "Allow location access in your browser, or search for your area below."
      : "Your device could not share its location. Try again or search for your area below.")),
    { enableHighAccuracy: false, timeout: 20000, maximumAge: 60000 }
  ));
  const { latitude, longitude } = coords;
  let name;
  try {
    const matches = await lookup("/reverse", { lat: latitude, lon: longitude, limit: 5 });
    for (const level of ["locality", "district", "city"]) {
      name = matches.map(place => place[level] || (place.type === level && place.name)).find(Boolean);
      if (name) break;
    }
  } catch {
    // Nearby discovery still works with coordinates when reverse lookup fails.
  }
  return { name: name || "Current Location", latitude, longitude };
}
