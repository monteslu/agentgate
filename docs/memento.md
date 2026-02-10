# Mementos (Agent Memory)

Durable memory storage for agents. Store snapshots tagged with keywords for long-term context.

## Key Concepts

- **Append-only** - Mementos are immutable once stored
- **Keyword tagging** - 1-10 keywords per memento (stemmed for matching)
- **Agent-scoped** - Each agent sees only their own mementos
- **Two-step retrieval** - Search returns metadata, then fetch full content

## Store a Memento

```bash
POST /api/agents/memento
Authorization: Bearer rms_your_key

{
  "content": "Decided to use PostgreSQL for the new project because...",
  "keywords": ["project", "database", "decision"]
}
```

Optional fields: `model`, `role`

Max content size: 12KB

## Search by Keyword

```bash
GET /api/agents/memento/search?keywords=project,decision&limit=10
```

Returns metadata (id, keywords, timestamp) without full content.

## Get Full Content

```bash
GET /api/agents/memento/42,38,15
```

Fetch up to 20 mementos by ID.

## List All Keywords

```bash
GET /api/agents/memento/keywords
```

## Recent Mementos

```bash
GET /api/agents/memento/recent?limit=5
```

## Use Cases

- Project decisions and rationale
- User preferences learned over time
- Important context from past conversations
- Status updates and progress logs
