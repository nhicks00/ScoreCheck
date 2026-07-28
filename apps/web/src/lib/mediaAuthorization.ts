export function whepResourceUrl(location: string | null, requestUrl: string): string | null {
  if (!location) return null;
  try {
    const pageUrl = typeof window === "undefined" ? "http://localhost/" : window.location.href;
    const request = new URL(requestUrl, pageUrl);
    const resource = new URL(location, request);
    for (const key of ["user", "pass"]) {
      const value = request.searchParams.get(key);
      if (value && !resource.searchParams.has(key)) resource.searchParams.set(key, value);
    }
    return resource.toString();
  } catch {
    return null;
  }
}

export function inheritMediaAuthorization(requestUrl: string, sourceUrl: string): string {
  try {
    const request = new URL(requestUrl, sourceUrl);
    const source = new URL(sourceUrl);
    if (request.origin !== source.origin) return request.toString();
    for (const key of ["user", "pass"]) {
      const value = source.searchParams.get(key);
      if (value && !request.searchParams.has(key)) request.searchParams.set(key, value);
    }
    return request.toString();
  } catch {
    return requestUrl;
  }
}
