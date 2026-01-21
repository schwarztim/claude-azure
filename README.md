<div align="center">

```
  ╔═╗
  ║Q║ Claude Azure
  ╚═╝
```

# Claude Azure

**Run Claude Code with Azure OpenAI, OpenAI, or Anthropic**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-18+-green)](https://nodejs.org/)

[Features](#features) • [Quick Start](#quick-start) • [Configuration](#configuration) • [Deployment Modes](#deployment-modes) • [Troubleshooting](#troubleshooting)

</div>

---

## Overview

**Claude Azure** is a fork of [Claude Code](https://github.com/anthropics/claude-code) that adds native support for Azure OpenAI and OpenAI alongside the standard Anthropic API. It provides a seamless local proxy that translates Anthropic API calls to Azure/OpenAI formats, letting you use Claude Code with your existing Azure deployments.

## Features

✨ **Multi-Provider Support**
- Azure OpenAI (Tiered or Model Router modes)
- OpenAI API
- Anthropic API (native passthrough)

🔧 **Flexible Deployment Options**
- **Tiered Mode**: Map model sizes to separate Azure deployments
- **Model Router Mode**: Single endpoint with Azure APIM routing

🚀 **Zero-Friction Setup**
- Interactive setup wizard
- Automatic proxy configuration
- Seamless Claude Code integration

🔒 **Secure Configuration**
- Local config storage (`~/.claude-azure/config.json`)
- No cloud credentials required beyond provider API keys

## Quick Start

### Prerequisites

1. **Install Claude Code** (required):
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```

2. **Azure OpenAI resource** (if using Azure) with deployed models

### Installation

```bash
# Clone and install
git clone https://github.com/schwarztim/claude-azure.git ~/Scripts/claude-azure
cd ~/Scripts/claude-azure
npm install
npm run build
npm link

# Run setup wizard
claude-azure
```

### First Run

The setup wizard will guide you through configuration:

```
  ╔═╗
  ║Q║ Claude Azure
  ╚═╝

  Claude Azure Setup
  ─────────────────────────────────────

? Select your AI provider:
❯ Azure OpenAI - Use Azure-hosted models
  OpenAI - Use OpenAI API directly
  Anthropic - Use Anthropic API directly
```

#### Azure OpenAI Configuration

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
# First run - interactive setup
claude-azure

# Reconfigure provider/settings
claude-azure --setup

# Reset all configuration
claude-azure --reset

# Show proxy debug logs
claude-azure --verbose

# Pass arguments to Claude Code
claude-azure -p "explain this codebase"
claude-azure --model sonnet
```

## Configuration

### Config File Location

`~/.claude-azure/config.json`

### Example Configuration (Tiered Mode)

```json
{
  "provider": "azure",
  "azure": {
    "endpoint": "https://myresource.openai.azure.com",
    "apiKey": "sk-...",
    "apiVersion": "2024-12-01-preview",
    "deployments": {
      "opus": "gpt-4o",
      "sonnet": "gpt-4o",
      "haiku": "gpt-4o-mini"
    }
  }
}
```

### Example Configuration (Model Router Mode)

```json
{
  "provider": "azure",
  "azure": {
    "endpoint": "https://myresource.openai.azure.com",
    "apiKey": "sk-...",
    "apiVersion": "2024-12-01-preview",
    "modelRouter": "model-router"
  }
}
```

## Deployment Modes

### Tiered Mode (Traditional)

**When to use:**
- Fine-grained control over model deployments
- Cost optimization by model size
- Different models for different tiers

**How it works:**
- Separate Azure deployments for each model class
- Maps Claude model names to your deployments:
  - `claude-opus-*` → `deployments.opus` (e.g., gpt-4o)
  - `claude-sonnet-*` → `deployments.sonnet` (e.g., gpt-4o)
  - `claude-haiku-*` → `deployments.haiku` (e.g., gpt-4o-mini)

### Model Router Mode (Azure APIM)

**When to use:**
- Azure API Management with routing logic
- Dynamic model selection
- Simplified deployment management

**How it works:**
- Single deployment endpoint
- Passes original Claude model name (e.g., `claude-sonnet-4`) to the router
- Your APIM policy routes to appropriate backend

## How It Works

```
┌─────────────────┐    ┌──────────────┐    ┌─────────────────┐
│   Claude Code   │───▶│ Local Proxy  │───▶│  Azure OpenAI   │
│                 │    │ (auto port)  │    │                 │
│ ANTHROPIC_BASE  │    │ Translates:  │    │ /chat/complete  │
│ _URL=localhost  │    │ Anthropic→   │    │                 │
│                 │    │ OpenAI       │    │                 │
└─────────────────┘    └──────────────┘    └─────────────────┘
```

**Key Components:**

1. **Claude Code** - The official Anthropic CLI tool
2. **Local Proxy** - Translates API formats in real-time
3. **Azure/OpenAI** - Your cloud AI provider

For Anthropic provider, no proxy is used (direct passthrough).

## Keeping Up to Date

Stay in sync with upstream Claude Code:

```bash
cd ~/Scripts/claude-azure
git fetch upstream
git merge upstream/main
npm install
npm run build
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `claude-azure: command not found` | Run `npm link` from project directory |
| `Claude Code not found` | Install from https://claude.ai/code |
| Connection errors | Verify endpoint/key in `~/.claude-azure/config.json` |
| Tool calls failing | Run with `--verbose` to see proxy request/response logs |
| Model not found | Check deployment names match your Azure resource |
| Rate limiting | Azure quotas apply - check Azure Portal metrics |

### Verbose Logging

```bash
claude-azure --verbose
```

Shows:
- Proxy startup details
- Request/response translation
- Azure API calls
- Error details

## Development

```bash
# Clone and install
git clone https://github.com/schwarztim/claude-azure.git
cd claude-azure
npm install

# Watch mode
npm run dev

# Build
npm run build

# Test locally
npm link
claude-azure --setup
```

## Architecture

```
src/
├── cli.ts           # Main entry point, setup wizard
├── config.ts        # Configuration management
├── proxy.ts         # API translation proxy
└── index.ts         # Exports

dist/                # Compiled JavaScript
~/.claude-azure/     # User configuration
  └── config.json
```

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Related Projects

- [Claude Code](https://github.com/anthropics/claude-code) - The official Anthropic CLI tool
- [Azure OpenAI](https://azure.microsoft.com/en-us/products/ai-services/openai-service) - Microsoft's Azure OpenAI service

## License

MIT License - See [LICENSE](LICENSE) for details

Azure wrapper code is MIT licensed. Original Claude Code license applies to upstream code.

## Acknowledgments

- Built on top of [Claude Code](https://github.com/anthropics/claude-code) by Anthropic
- Inspired by the need for Azure OpenAI enterprise deployment support

---

<div align="center">

**Made with ❤️ for Azure OpenAI users**

[Report Bug](https://github.com/schwarztim/claude-azure/issues) • [Request Feature](https://github.com/schwarztim/claude-azure/issues)

</div>
