import { serviceInfo as githubInfo } from '../src/routes/github.js';
import { serviceInfo as blueskyInfo } from '../src/routes/bluesky.js';
import { serviceInfo as mastodonInfo } from '../src/routes/mastodon.js';
import { serviceInfo as redditInfo } from '../src/routes/reddit.js';
import { serviceInfo as calendarInfo } from '../src/routes/calendar.js';
import { serviceInfo as youtubeInfo } from '../src/routes/youtube.js';
import { serviceInfo as linkedinInfo } from '../src/routes/linkedin.js';
import { serviceInfo as jiraInfo } from '../src/routes/jira.js';
import { serviceInfo as fitbitInfo } from '../src/routes/fitbit.js';
import { serviceInfo as braveInfo } from '../src/routes/brave.js';
import { serviceInfo as googleSearchInfo } from '../src/routes/google-search.js';

const allServices = [
  githubInfo,
  blueskyInfo,
  mastodonInfo,
  redditInfo,
  calendarInfo,
  youtubeInfo,
  linkedinInfo,
  jiraInfo,
  fitbitInfo,
  braveInfo,
  googleSearchInfo
];

describe('Service Info Exports', () => {
  describe('Required fields', () => {
    it.each(allServices)('$name should have all required fields', (service) => {
      expect(service.key).toBeDefined();
      expect(typeof service.key).toBe('string');

      expect(service.name).toBeDefined();
      expect(typeof service.name).toBe('string');

      expect(service.shortDesc).toBeDefined();
      expect(typeof service.shortDesc).toBe('string');

      expect(service.description).toBeDefined();
      expect(typeof service.description).toBe('string');

      expect(service.authType).toBeDefined();
      expect(typeof service.authType).toBe('string');

      expect(service.docs).toBeDefined();
      expect(service.docs).toMatch(/^https?:\/\//);

      expect(service.examples).toBeDefined();
      expect(Array.isArray(service.examples)).toBe(true);
      expect(service.examples.length).toBeGreaterThan(0);
    });
  });

  describe('Example format', () => {
    it.each(allServices)('$name examples should follow correct format', (service) => {
      for (const example of service.examples) {
        expect(example).toMatch(/^GET \/api\//);
        expect(example).toContain(`/api/${service.key}/`);
        expect(example).toContain('{accountName}');
      }
    });
  });

  describe('Unique keys', () => {
    it('all services should have unique keys', () => {
      const keys = allServices.map(s => s.key);
      const uniqueKeys = [...new Set(keys)];
      expect(keys.length).toBe(uniqueKeys.length);
    });
  });

  describe('GitHub writeGuidelines', () => {
    it('should have writeGuidelines', () => {
      expect(githubInfo.writeGuidelines).toBeDefined();
      expect(Array.isArray(githubInfo.writeGuidelines)).toBe(true);
      expect(githubInfo.writeGuidelines.length).toBeGreaterThan(0);
    });

    it('should mention branches and PRs', () => {
      const guidelinesText = githubInfo.writeGuidelines.join(' ').toLowerCase();
      expect(guidelinesText).toContain('branch');
      expect(guidelinesText).toContain('pull request');
    });
  });

  describe('Calendar dbKey', () => {
    it('should have dbKey for google_calendar mapping', () => {
      expect(calendarInfo.dbKey).toBe('google_calendar');
    });
  });
});
