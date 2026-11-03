const fileWorkloads = [
  { name: 'cached-files', path: '/files' },
  { name: 'download', path: '/files/{id}' },
];

export const cases = {
  node: {
    services: ['caddy', 'web', 'db', 'redis', 's3'],
    setup: ['s3-init', 'migrate'],
    workloads: fileWorkloads,
  },
  django: {
    services: ['caddy', 'web', 'db', 'redis', 's3'],
    setup: ['s3-init', 'migrate'],
    workloads: fileWorkloads,
  },
  laravel: {
    services: ['caddy', 'web', 'db', 'redis', 's3'],
    setup: ['s3-init', 'migrate'],
    workloads: fileWorkloads,
  },
  wordpress: {
    services: ['caddy', 'web', 'db'],
    setup: ['install'],
    workloads: [{ name: 'homepage', path: '/' }],
  },
};
