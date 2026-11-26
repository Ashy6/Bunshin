let sessionExpirySignalled = false;

export function signalSessionExpiry() {
  if (sessionExpirySignalled) return;
  sessionExpirySignalled = true;
  window.dispatchEvent(new CustomEvent("bunshin:session-expired"));
}

export async function adminFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) signalSessionExpiry();
  return response;
}

export function watchAdminUpload(request: XMLHttpRequest) {
  if (request.status === 401) signalSessionExpiry();
}
