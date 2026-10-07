# Monday.com integration

## Deploying

### Webhook address (AQU-1770)

When a project is linked to a board, the identity Worker asks Monday to create
board webhooks that call back `<BASE_URL_API>/api/v2/monday/webhook`. Monday
first POSTs a challenge to that address and refuses to create the webhook unless
the challenge is echoed back.

`BASE_URL_API` must therefore be the identity API host, not the website:

| Environment | `BASE_URL_API` |
| --- | --- |
| production | `https://api.aquilla.app/identity` |
| development | `https://api.dev.aquilla.app/identity` |
| local / previews / e2e | unset: falls back to `MCP_OAUTH_ISSUER`, then to the address the Worker was reached on |

The website (`BASE_URL`, e.g. `https://dev.aquilla.app`) answers the challenge
with 405. Before AQU-1770 the fallback was `BASE_URL`, and `BASE_URL_API` was set
nowhere, so every link on dev and production saved with the warning "could not
create Monday webhooks…" and no webhooks.

Links saved before this ships have an empty webhook list. Saving such a link
again (project settings → Monday → save the mapping) creates the webhooks, because
the link route creates them whenever the stored list is empty. Unlinking and
linking again also works. No data migration is needed.
