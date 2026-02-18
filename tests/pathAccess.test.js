import { matchesPattern } from '../src/lib/pathMatcher.js';

describe('matchesPattern', () => {
  it('matches exact paths', () => {
    expect(matchesPattern('repos/owner/repo', 'repos/owner/repo')).toBe(true);
  });

  it('rejects non-matching exact paths', () => {
    expect(matchesPattern('repos/owner/repo', 'repos/owner/other')).toBe(false);
  });

  it('matches single wildcard segments', () => {
    expect(matchesPattern('repos/*/repo', 'repos/anything/repo')).toBe(true);
    expect(matchesPattern('repos/*/repo', 'repos/other/repo')).toBe(true);
  });

  it('rejects wildcard with wrong structure', () => {
    expect(matchesPattern('repos/*/repo', 'repos/a/b/repo')).toBe(false);
  });

  it('matches glob suffix', () => {
    expect(matchesPattern('repos/**', 'repos/a/b/c')).toBe(true);
    expect(matchesPattern('repos/**', 'repos/anything')).toBe(true);
  });

  it('rejects when pattern is longer than path', () => {
    expect(matchesPattern('repos/owner/repo/extra', 'repos/owner/repo')).toBe(false);
  });

  it('rejects when path is longer than pattern (no glob)', () => {
    expect(matchesPattern('repos/owner', 'repos/owner/repo')).toBe(false);
  });

  it('handles leading/trailing slashes', () => {
    expect(matchesPattern('/repos/owner/', '/repos/owner/')).toBe(true);
    expect(matchesPattern('/repos/owner', 'repos/owner/')).toBe(true);
  });
});
