import { ROUTE_REGISTRY, getRouteRegistry } from '../src/lib/routeRegistry.js';

describe('routeMeta exports', () => {
  it('registry is a non-empty array', () => {
    expect(Array.isArray(ROUTE_REGISTRY)).toBe(true);
    expect(ROUTE_REGISTRY.length).toBeGreaterThan(0);
  });

  it('getRouteRegistry() returns the same array', () => {
    expect(getRouteRegistry()).toBe(ROUTE_REGISTRY);
  });

  it.each(ROUTE_REGISTRY.map(m => [m.name, m]))('%s has required fields', (_name, meta) => {
    expect(typeof meta.name).toBe('string');
    expect(meta.name.length).toBeGreaterThan(0);
    expect(typeof meta.description).toBe('string');
    expect(meta.description.length).toBeGreaterThan(0);
    expect(['proxy', 'internal', 'admin']).toContain(meta.category);
    expect(Array.isArray(meta.endpoints)).toBe(true);
    expect(meta.endpoints.length).toBeGreaterThan(0);
  });

  it.each(
    ROUTE_REGISTRY.flatMap(m =>
      m.endpoints.map(ep => [`${m.name} — ${ep.method} ${ep.path}`, ep])
    )
  )('%s has valid endpoint fields', (_label, ep) => {
    expect(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).toContain(ep.method);
    expect(typeof ep.path).toBe('string');
    expect(ep.path.length).toBeGreaterThan(0);
    expect(typeof ep.description).toBe('string');
    expect(['agent', 'admin', 'none']).toContain(ep.auth);
  });

  it('all expected route files are represented', () => {
    const names = ROUTE_REGISTRY.map(m => m.name);
    expect(names).toContain('Agent Messaging');
    expect(names).toContain('Write Queue');
    expect(names).toContain('Mementos');
    expect(names).toContain('LLM Proxy');
    expect(names).toContain('Channel');
    expect(names).toContain('Webhooks');
    expect(names).toContain('Services');
    expect(names).toContain('Skills');
    expect(names).toContain('MCP Transport');
  });
});
