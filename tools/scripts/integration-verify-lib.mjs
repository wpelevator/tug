import assert from 'node:assert/strict';

/** Discovery may replace a client after its first serving report; retry only that known gap. */
export async function inspectPublishedServices(services, inspect) {
  for (const service of services) {
    let containers;
    try {
      containers = await inspect(service);
    } catch (error) {
      if (error?.stderr?.trim() === 'Service has no container on this node') return false;
      throw error;
    }
    assert.ok(containers.length > 0, 'each published service must have a running container');
    for (const container of containers)
      assert.match(
        container.Config.Image,
        /@sha256:[a-f0-9]{64}$/,
        'running containers must use the digest pinned by control',
      );
  }
  return true;
}
