# Model services

The frontend supports OpenRouter and Abliteration.ai. The selected service is
shared by the GM and AI characters; characters can use a different model on that
service. Local model servers are not implemented yet.

## Setup

1. Restart the Armat-sur server if it was already running, then reload the frontend.
2. Open Settings and select Abliteration.ai under API service.
3. Enter an Abliteration.ai API key and click Fetch model list / test connection.
4. Select the exact GM model returned by your account and optionally a character
   model. Manual model IDs are also accepted; website display names may differ
   from API IDs.
5. Save. Switching services retains each service's keys and model choices.

The rulebook and enabled reference images use the same generation pipeline for
both services. Image input requires a vision-capable model. Missing catalog
metadata is shown as unknown: do not assume a model supports images or has enough
context merely because the provider supports the message format. Costs remain
unknown unless supplied by the API or a catalog with per-token pricing.

## Connection details

- OpenRouter: browser-direct to https://openrouter.ai/api/v1.
- Abliteration.ai: through the included local Python server to
  https://api.abliteration.ai/v1. A generic static-file server is insufficient.
  As checked on 2026-09-28, the API rejects localhost browser CORS origins.
- Only model-list and chat-completion endpoints are relayed, to a fixed host.
  TLS verification stays enabled; redirects are not followed.
- Keys remain in browser-local settings. The relay uses the supplied key in memory
  for the request, without logging or saving it. Session exports exclude settings.
- The relay accepts requests up to 128 MiB including base64 images. Upstream model
  limits may be smaller. Large collections should use appropriately sized images.
- Existing OpenRouter upstream routing controls appear only for OpenRouter.

## Verification and limitations

Regression tests cover service isolation, draft cancellation, delayed model-list
responses, SSE/tools/reasoning, multimodal payloads, provider errors, and relay
origin/host/endpoint restrictions. A live model-list relay check with an invalid
key reached the provider's authentication response. Authenticated generation and
account-specific model availability require a real API key and have not been tested.

References checked during implementation:
- https://abliteration.ai/docs/openai-compatibility
- https://abliteration.ai/docs/vision
- https://api.abliteration.ai/openapi.json
