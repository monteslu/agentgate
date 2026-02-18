// Pattern matching for path access control.
// Supports exact match, wildcard segments (*), and glob suffix (**)
export function matchesPattern(pattern, path) {
  // Normalize: strip leading/trailing slashes
  pattern = pattern.replace(/^\/|\/$/g, '');
  path = path.replace(/^\/|\/$/g, '');

  const patternParts = pattern.split('/');
  const pathParts = path.split('/');

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === '**') {
      // Glob: matches everything from here on
      return true;
    }
    if (i >= pathParts.length) {
      return false;
    }
    if (patternParts[i] === '*') {
      // Wildcard: matches any single segment
      continue;
    }
    if (patternParts[i] !== pathParts[i]) {
      return false;
    }
  }

  return patternParts.length === pathParts.length;
}
