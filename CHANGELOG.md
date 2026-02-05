# Changelog

All notable changes to agentgate will be documented in this file.

## [0.4.0] - 2026-02-05

### Added
- **Shared Queue Visibility** - Agents can see all queue items when enabled (#20)
- **Agent Withdraw** - Agents can withdraw their own pending submissions (#20, #22)
- **Broadcast Messages** - Send messages to all agents at once (#24)
- **Queue Settings UI** - Admin panel for shared visibility and agent withdraw (#25)
- **Real-time UI Updates** - Socket.io integration for live queue/message counts (#23)
- **Best Practice Docs** - Notification action-trigger policy in /api/readme (#29)

### Changed
- **UI Refactored** - Split monolithic ui.js into focused modules (#28)
- **Webhook Setup Docs** - Clearer two-sided setup instructions (#26, #27)

### Fixed
- Withdraw endpoint ownership validation (#22)

## [0.3.2] - 2026-02-04

- Initial public release
