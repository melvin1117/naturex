## Summary
<!-- 1–3 bullets: what changed and why -->

## Task
<!-- Link the GitHub issue, e.g. Closes #10 -->

## Independent review
<!-- A separate agent with fresh context (not the one that wrote the code) reviewed the diff
     with the code-review-and-quality skill before this PR (prompt: docs/ai-setup.md).
     Write "None" if there were no Critical or Required findings. -->
- [ ] Reviewed by a separate agent (`code-review-and-quality`; plus `security-and-hardening` if auth, cookies, sessions, user input or LLM prompts changed), or N/A: trivial change (say why)
- Findings fixed: …
- Findings rejected (and why): …

## Test plan
- [ ] `make ci` passes locally (`docker compose up -d` first)
- [ ] 1 teammate approval; merge with **Squash and merge** only after CI is green
- [ ] Manual check (if UI/API): …

## Notes
<!-- Risks, follow-ups, screenshots -->
