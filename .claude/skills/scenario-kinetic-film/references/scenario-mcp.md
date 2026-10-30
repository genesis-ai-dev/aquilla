# What Scenario MCP does in this skill

The film's motion is code and never needs a model. Scenario MCP makes what code cannot: the music bed, the
sound-effect kit, and any picture the film cuts in (key art, a product, a character, a screenshot redrawn).

## 0. Connect and pick a scope

Call `teams_list`. If the Scenario tools are missing or the call fails to authenticate, stop and give the
user the setup: add the MCP server `https://mcp.scenario.com` to the agent (in Claude Code:
`claude mcp add --transport http scenario https://mcp.scenario.com`), sign in with a Scenario account, and
optionally install the companion skills with `npx skills add scenario-labs/skills`.

If several teams or projects come back, ask the user which to use; do not pick one. Pass `team_id` and
`project_id` to every later call. With a signed-in (OAuth) account, `search`, `model_schema_get` and
`model_run` refuse to run without them; `recommend` works without them but then ranks the whole public
catalogue instead of what the team can use. If the account supports it, `memory_recall` returns saved
workspace instructions worth reading before generating.

## 1. The loop for every generation step

1. **Choose the model** with `recommend`: the user's intent as `prompt`, a `capability` (`txt2audio` for
   music and sounds, `txt2img` or `img2img` for pictures) and `limit`. When `next_step.type` is `ask_user`,
   show the question and options and wait. When it is `no_match`, explain what is missing; do not relax the
   requirement silently. Read each entry's `caveats`. Take model ids from these results, never from memory.
2. **Read the inputs** with `model_schema_get`: field names, which fields take arrays (reference images),
   allowed values, and inputs that change the cost (duration, number of outputs, resolution).
3. **Upload the user's files** before any run that uses them: `upload_asset` with `file_name`,
   `content_type`, `kind` and `file_size` (from `wc -c`), PUT each part to the returned URL with curl, then
   `upload_asset_complete` with the `upload_id`. Pass the returned asset id to `model_run`; it never takes a
   local path. Outputs of earlier runs are already assets: pass their ids directly.
4. **Price it**: `model_run` with `dry_run: true` and the full parameters. Tell the user the price of each
   step and the total for the whole soundtrack and picture set, and wait for a go before the first paid run.
5. **Run**: `model_run` (`"wait": false` for a batch such as a sound kit), then one `jobs_wait` with all job
   ids (at most 32). If it returns `pending_job_ids`, call `jobs_wait` again with those.
6. **Download**: `asset_download` with the asset id (`"format": "png"` for a picture; nothing for audio),
   then `curl -L -o <file> "<url>"` (follow redirects).

## 2. When a run fails

`job_get` with the job id shows the error and a hint. A blocked prompt usually names its reason: rewrite
the prompt rather than retrying it (a request that mentions removing watermarks from a reference image is
blocked; a generated picture that infringes a brand gets a brand-free rewrite). A failed run can still be
charged: check before running it again, and tell the user.

## 3. What to keep

Keep the asset ids next to the files (a small text file in `audio/` and `art/`) so a later edit can pass a
picture back as a reference image without uploading it again.
