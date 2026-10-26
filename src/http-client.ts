import { HubError } from './contracts.js';
import { SERVICE, validateHubUrl } from './config.js';

export async function request(url: string, token: string, path: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await fetch(validateHubUrl(url) + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json() as any;
  if (!response.ok) throw new HubError(response.status, result.error ?? `HTTP ${response.status}`);
  return result;
}
export async function verifyHub(url: string, instanceId: string): Promise<void> {
  const response = await fetch(validateHubUrl(url) + '/health', { redirect: 'error', signal: AbortSignal.timeout(3000) });
  const result = await response.json() as any;
  if (!response.ok || result.service !== SERVICE || result.instanceId !== instanceId) {
    throw new HubError(409, 'This port is not your configured agent-mail-hub instance; credentials were not sent');
  }
}
