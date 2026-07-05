"""Manager 'Wellbeing Assistant' chat — hybrid grounded agent.

See docs/manager-chat.md for the full architecture. Modules:
  tools        — PII-safe grounding tools (operational aggregates + Mithra RAG)
  guardrails   — hybrid input/output guardrails
  orchestrator — Azure OpenAI tool loop + streaming synthesis
  routes       — SSE endpoint + chat REST
"""
