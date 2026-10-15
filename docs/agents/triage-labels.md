# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

This repo uses the default vocabulary unchanged.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

## Recording state locally

The tracker is local markdown, so a label is not applied with a CLI. Record it as a `Status:` line near the top of the issue file:

```markdown
Status: ready-for-agent
```

The five status strings above are the only valid values. Edit the "Label in our tracker" column if the vocabulary ever changes.
