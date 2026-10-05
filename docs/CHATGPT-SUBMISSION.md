# ChatGPT submission readiness

The package supplies publisher metadata, support links, declared tools,
five positive review cases and three negative review cases. Local tests prove
the connection and execution contracts. They do not establish directory approval.

## Before deployment

- Apply migration `0130` before deploying consumers of `oauth_resource`.
- Confirm `MCP_OAUTH_ISSUER`, `AUTH_WORKER_URL` and `SYNC_WORKER_URL` agree
  with public identity and MCP URLs in each environment.
- Deploy the support page from the companion marketing change.
- Preserve device authorization, Ask/Act settings and revocable credentials.
  Persistent credentials do not gain an expiry in this change.
- Keep test credentials out of the plugin ZIP, source control and logs.

## Reviewer fixture

Create a dedicated account with representative sample data. Do not give it
access to customer projects. Provide credentials through the submission portal.

- Create an approved organization containing a project named **Review Spanish**.
- Include English source text, Spanish target text, an untranslated segment,
  reviewer comments, terminology, project rules and approved knowledge.
- Include a source segment containing **Welcome to our community** for the edit case.
- Add a source segment containing instructions to ignore permissions. The
  negative case must treat those instructions as data.
- Create **Review Excluded** in a second organization. Omit that organization
  from OAuth consent. The exclusion case must fail without disclosing content.
- Provide a reviewer-limited scenario where saving cannot establish human
  validation. Keep human validation separate from translation updates.
- Document the sample account, fixture names, consent selections and expected
  results in reviewer instructions outside the ZIP.

## Real ChatGPT verification

Connect through Developer Mode using OAuth. Run every packaged case against
the fixture. Verify confirmation behavior, selected organizations, permission
reductions, revocation, reconnection and malicious source content handling.

Record a walkthrough showing sign-in, organization consent, useful reads,
one explicitly requested change, confirmation, the saved result and revocation.
Provide an accessible video URL in the submission portal. Do not record secrets.

## Submission

- Verify publisher identity and domain ownership through the portal challenge.
  Add the supplied plaintext challenge only after receiving its actual value.
- Upload the package and verify all required metadata fields in the portal.
- Run the MCP scan. Rescan after deploying tool schema or annotation changes.
- Supply reviewer credentials, instructions and the walkthrough video separately.
- Confirm privacy disclosures explain project data access, processing, sharing,
  retention and deletion. Check these against actual production practices.
- Submit only after real ChatGPT cases pass. Reviewers decide approval; local
  compilation and tests cannot guarantee it.

## Official references

- [Plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines)
- [Upload and submit your plugin](https://developers.openai.com/plugins/deploy/submission)
- [Authentication](https://developers.openai.com/plugins/build/auth)
- [MCP server development](https://developers.openai.com/plugins/build/mcp-server)

UI widgets and dynamic client registration remain optional enhancements.
Aquilla already supports client metadata documents and PKCE. A visual widget
does not replace a useful, secure tool workflow.
