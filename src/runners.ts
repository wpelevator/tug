// Injectable seams for the agent's side effects so rollout/health/secret logic can be unit-tested
// without a real Docker daemon or control plane. Docker itself is the `DockerApi` in `docker-api.ts`.
export type HttpClient = typeof fetch;
