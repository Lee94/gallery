# Gallery Skills

A skill set for AI agents that create, publish, and manage artifacts on a
[Gallery](../README.md) instance — modeled after Claude's artifact skills
(`SKILL.md` with YAML frontmatter, plus optional `references/` files).

| Skill | Load when |
| --- | --- |
| [`gallery-artifact`](gallery-artifact/SKILL.md) | Entry point: publishing, updating, and managing shares through the Gallery MCP tools. Always start here. |
| [`gallery-artifact-design`](gallery-artifact-design/SKILL.md) | Before writing any HTML artifact: layout, theming, and the sandbox constraints that shape the code. |
| [`gallery-page-data`](gallery-page-data/SKILL.md) | The artifact needs shared page JSON, per-visitor state, KV collections, realtime updates, or attachments. |
| [`gallery-page-llm`](gallery-page-llm/SKILL.md) | The artifact calls the server-side LLM (`Gallery.llm`). |
| [`gallery-react-artifact`](gallery-react-artifact/SKILL.md) | The artifact uses the React runtime (JSX/TSX entry, multi-file builds). |

## Install

Copy the skill directories into your agent's skill search path, e.g. for Claude Code:

```bash
# personal, all projects
cp -R skills/gallery-* ~/.claude/skills/

# or project-local, shared with the team
cp -R skills/gallery-* .claude/skills/
```

The skills assume the Gallery MCP server is connected (its tools appear as
`mcp__gallery__*`). Authentication uses an API token created at `/settings/tokens`.

**No MCP?** The skills also describe the CLI fallback: [`cli/gallery.mjs`](../cli/README.md)
is a zero-dependency Node client for the same endpoint. `gallery call <tool>
'<json-args>'` mirrors every MCP tool one-to-one, with `GALLERY_URL` and
`GALLERY_TOKEN` for configuration.

The page-side API they describe lives in `public/sdk/page-state-v1.js`; TypeScript
declarations are in `public/sdk/page-state-v1.d.ts`. Keep the skills in sync with
those files and with `src/lib/mcp/tools.ts` when the platform changes.
