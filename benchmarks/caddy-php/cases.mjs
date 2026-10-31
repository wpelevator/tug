export const cases = {
  direct: { stack: 'direct', target: 'nginx', services: ['nginx', 'php'], workload: 'php' },
  proxy: { stack: 'proxy', target: 'caddy', services: ['caddy', 'nginx', 'php'], workload: 'php' },
  'caddy-php': { stack: 'caddy-php', target: 'caddy', services: ['caddy', 'php'], workload: 'php' },
  'static-nginx': { stack: 'static', target: 'nginx', services: ['nginx'], workload: 'static' },
  'static-proxy': {
    stack: 'static',
    target: 'caddy',
    services: ['caddy', 'nginx'],
    workload: 'static',
  },
  'static-caddy': {
    stack: 'static',
    target: 'caddy-direct',
    services: ['caddy-direct'],
    workload: 'static',
  },
};
