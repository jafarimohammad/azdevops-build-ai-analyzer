# Azure DevOps Build AI Analyzer

Automatically explains **why your pipeline failed** using an LLM of your choice — including a **local, self-hosted model** (Ollama, LM Studio, vLLM, llama.cpp) or any OpenAI-compatible API.

When a build fails, a pipeline task reads the logs of the **failed tasks**, sends them to your LLM, and attaches a structured diagnosis to the build. An **AI Analyzer** tab on the build results page then shows the summary, likely root cause, key errors, and suggested fixes.

No separate backend, no extra ports, no inbound changes to your Azure DevOps server — everything ships inside the extension, and the LLM is only ever called from the build agent.

![AI Analyzer tab showing a diagnosed build failure](https://raw.githubusercontent.com/jafarimohammad/azdevops-build-ai-analyzer/main/extension/images/screenshot-analysis.png)

## Quick start

1. Install this extension into your organization, then into your project.
2. Add the task to the end of your job:

```yaml
- task: AIBuildAnalyzer@2
  displayName: AI Build Analyzer
  condition: failed()
  inputs:
    llmUrl: http://localhost:11434/v1   # your OpenAI-compatible endpoint
    llmModel: llama3.1
```

3. From the next failed run onward, open the build's **AI Analyzer** tab.

## Use your own LLM

The task works with any OpenAI-compatible `/v1/chat/completions` endpoint that your **build agent** can reach. Set `llmUrl` and `llmModel`; optionally `llmApiKey` (use a secret variable), `insecureTls` (for self-signed HTTPS), and `timeoutMs`.

| Backend | `llmUrl` | `llmModel` |
|---------|----------|------------|
| Ollama | `http://localhost:11434/v1` | `llama3.1` |
| LM Studio | `http://localhost:1234/v1` | _loaded model_ |
| vLLM / llama.cpp | `http://host:8000/v1` | _served model_ |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |

If the LLM is unreachable, the task falls back to a built-in offline **heuristic** analyzer that recognizes common CI failures.

## Documentation & source

Full docs, configuration, and troubleshooting:
**https://github.com/jafarimohammad/azdevops-build-ai-analyzer**

Licensed under MIT.
