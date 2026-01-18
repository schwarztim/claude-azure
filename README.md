# Claude Azure

> **Fork of [Claude Code](https://github.com/anthropics/claude-code) with native Azure OpenAI support**

Use **Claude Code** with **Azure OpenAI**, OpenAI, or Anthropic - your choice!

## Quick Start

```bash
# Clone and install
git clone https://github.com/schwarztim/claude-code.git ~/Scripts/claude-azure
cd ~/Scripts/claude-azure
npm install
npm run build
npm link

# Run (wizard will guide you)
claude-azure
```

## Setup Wizard

When you run `claude-azure`, it presents a setup wizard:

```
  Claude Azure Setup
  ─────────────────────────────────────

? Select your AI provider:
❯ Azure OpenAI - Use Azure-hosted models
  OpenAI - Use OpenAI API directly
  Anthropic - Use Anthropic API directly
```

Then for Azure, enter your credentials:
```
Azure OpenAI Configuration
Get these from Azure Portal → Azure OpenAI → Keys and Endpoint

? Azure OpenAI Endpoint: https://myresource.openai.azure.com
? Azure OpenAI API Key: ********
? API Version: 2024-12-01-preview

Deployment Mode
? Select deployment mode:
  ❯ Tiered - Separate deployments for different model sizes
    Model Router - Single deployment for all models

# For Tiered mode:
? Opus/Large model deployment: gpt-4o
? Sonnet/Medium model deployment: gpt-4o
? Haiku/Small model deployment: gpt-4o-mini

# For Model Router mode:
? Model Router deployment name: model-router

✔ Testing Azure connection...
✓ Configuration saved!
```

## Usage

```bash
# First run - setup wizard
claude-azure

# Reconfigure
claude-azure --setup

# Show proxy logs
claude-azure --verbose

# Reset all config
claude-azure --reset

# Pass any args to Claude Code
claude-azure -p "explain this codebase"
```

## Configuration

Config stored in `~/.claude-azure/config.json`

### Deployment Modes

**Tiered Mode** (Traditional)
- Separate Azure deployments for each model size
- Maps claude-opus-* → opus deployment, claude-sonnet-* → sonnet deployment, etc.
- Best for: Fine-grained control, different models per tier, cost optimization

**Model Router Mode** (Azure APIM)
- Single deployment endpoint that routes based on model name in request
- Passes original Claude model name (e.g., "claude-sonnet-4") to the router
- Best for: Azure API Management routing, dynamic model selection, simplified setup

### Model Mapping (Tiered Mode)

| Claude Model | Maps To Your Deployment |
|--------------|-------------------------|
| claude-opus-* | "opus" (e.g., gpt-4o) |
| claude-sonnet-* | "sonnet" (e.g., gpt-4o) |
| claude-haiku-* | "haiku" (e.g., gpt-4o-mini) |

## How It Works

```
┌─────────────────┐    ┌──────────────┐    ┌─────────────────┐
│   Claude Code   │───▶│ Local Proxy  │───▶│  Azure OpenAI   │
│                 │    │ (port auto)  │    │                 │
│ ANTHROPIC_BASE  │    │ Translates:  │    │ /chat/complete  │
│ _URL=localhost  │    │ Anthropic→   │    │                 │
│                 │    │ OpenAI       │    │                 │
└─────────────────┘    └──────────────┘    └─────────────────┘
```

For Anthropic provider, it passes through directly (no proxy needed).

## Keeping Up to Date

Sync with upstream Claude Code:

```bash
cd ~/Scripts/claude-azure
git fetch upstream
git merge upstream/main
npm run build
```

## Prerequisites

1. **Claude Code** must be installed first:
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```

2. **Azure OpenAI** resource with deployed models

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Claude Code not found" | Install from https://claude.ai/code |
| Connection errors | Check endpoint/key in `~/.claude-azure/config.json` |
| Tool calls not working | Run with `--verbose` to see proxy logs |

---

## Original Claude Code

This is a fork of [Claude Code](https://github.com/anthropics/claude-code), an agentic coding tool that lives in your terminal.

For official documentation, see [code.claude.com](https://code.claude.com/docs/en/overview).

## License

MIT (azure wrapper) / Original Claude Code license applies to upstream code
