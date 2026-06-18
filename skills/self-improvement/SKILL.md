---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Skill: self-improvement

The final task of every engagement. Look at what just happened, identify whether a structural lesson (a missing skill, a role that should split, a rule that should land) is in evidence, and route the lesson to the right destination.

## Procedure

At the end of every dispatch (every role, including the liaison and the steward), spend a brief reflection on:

1. **Was anything in your dispatch's procedure surprising?** A missing skill, a step the role file did not name, a tool that did not work the way you expected.
2. **Did you make a mistake the role file or a skill could have prevented?** Misread a frontmatter field, posted to the wrong branch, forgot to commit the inbox state.
3. **Did the role file say something that does not match what you actually did?** Drift between the role's stated procedure and the procedure that worked.

If the answer to all three is no, your report ends with `Self-improvement: nothing this time.` and you are done.

If the answer to any is yes, route the lesson:

- **One observation, single role.** Write it as a *Note from the field* in your `result` entry's body. The next engagement of the same role reads recent entries and picks it up.
- **Pattern across engagements (you have seen this twice or more).** Write a `message: <your-role> → liaison` journal entry naming the pattern and proposing a change to the role file or the relevant skill. The liaison lands the change on `main` in its own checkout.
- **Structural (a missing role, a skill that should be carved, a rule that should bind future sessions).** Same shape: `message: <your-role> → liaison`. The liaison decides whether to author the change directly or to wait until a `gardener`-shaped role is carved here.

## Threshold for landing a change

- One observation, one engagement: note in the field. Do not land a rule.
- Two engagements, same observation: candidate for a rule. Propose to liaison.
- Three or more, recurring: definitely a rule. Land the change.

The maintainer's framing: rules are expensive (every future agent reads them). A rule that fires once and then never again wastes context for every dispatch thereafter. Notes from the field are cheap because only the next same-role engagement reads them.

## Report format

The final line of every `result` entry's body, and every final-message-to-orchestrator, is:

```
Self-improvement: <one-line summary, or "nothing this time.">
```

Examples:

- `Self-improvement: nothing this time.`
- `Self-improvement: noted in field that the auditor's pricing-freshness invariant needs an explicit timezone; flagged for the liaison.`
- `Self-improvement: proposed to liaison that the planner role file should name the proposal_hash computation explicitly; ymax-planner-protocol skill should grow a "Hash composition" section.`

## Notes

This is the only skill every role uses every time. It is the single most important convention in finbot for making the library improve itself; the parent garden's experience is that without an explicit self-improvement step, lessons die in agent contexts and never compound.
