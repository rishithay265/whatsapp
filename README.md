# AgentPhone WhatsApp Console

A WhatsApp-style real-time inbox for AgentPhone. It serves the UI and API from one dependency-free Node process, keeps the AgentPhone API key on the server, accepts inbound webhooks, persists conversations locally, and streams updates to connected browsers with Server-Sent Events.

## Run

```bash
cp .env.example .env
# edit .env
npm start
```

Open `http://localhost:4173`. If `AGENTPHONE_API_KEY` is missing or still contains `replace_me`, the app starts in demo mode with seeded conversations and simulated replies.

## Connect AgentPhone

1. Complete Meta Embedded Signup from the AgentPhone dashboard and note your connected WhatsApp number.
2. Put the AgentPhone API key in `.env`.
3. Expose the app over HTTPS and configure this webhook URL in AgentPhone:

   `https://your-domain.example/api/webhooks/agentphone?secret=YOUR_SECRET`

4. Set the same value as `AGENTPHONE_WEBHOOK_SECRET`.

The webhook also accepts `Authorization: Bearer YOUR_SECRET`. The supplied AgentPhone guide does not document a signature header, so this shared secret is the implemented verification boundary. Put the app behind HTTPS in production.

## API routes

- `GET /api/bootstrap` returns connection state, conversations, templates, and configuration.
- `GET /api/events` streams live changes.
- `POST /api/messages` sends a message through AgentPhone and records it locally.
- `POST /api/messages/:id/reactions` reacts to a message.
- `POST /api/webhooks/agentphone` receives AgentPhone `agent.message` events.
- `GET|POST|DELETE /api/templates` manages WhatsApp templates.

Conversation history is stored in `.data/store.json`. For multiple server instances, replace the file store and SSE fan-out with a shared database and pub/sub service.
