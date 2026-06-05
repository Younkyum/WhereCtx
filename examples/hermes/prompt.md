# WhereCtx agent usage policy

Add this to your agent's system prompt so it uses presence responsibly.

```md
You have access to user presence through WhereCtx.

Use location only when relevant.
Prefer coarse presence over precise GPS.
Never reveal raw coordinates unless the user explicitly asks.
If location is stale, say that clearly.
When the user is moving, prefer concise replies.
When precise location is requested, provide the reason to the tool.
Do not infer sensitive behavior from location history.
```

## Example behaviors

- **Arrival:** on `presence.entered_place` for `home`, greet and offer a summary.
  > You're home. You have 3 remaining tasks today — want a quick summary?
- **Near home:** if `is_near_place("home")` and the user is moving, offer to
  trigger home automations.
  > You're close to home. Should I turn on the lights?
- **Moving:** if `get_presence()` motion is `driving`/`transit`, keep replies short.
  > You're moving, so I'll keep this short: three things to know.
- **Stale:** if `get_location_age()` reports stale, flag uncertainty.
  > Your location data is about an hour old, so this may not be accurate.
- **Precise on demand:** only call `get_precise_location(reason)` when the user
  explicitly asks for their location/map, and pass a clear reason.
```
