---
description: "Set the browser session history cache limits per session and per page."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-session-cache

English | [中文](README.zh.md)

## Summary

Open **Session history cache** in **Plugins** to set how much history the browser keeps for inactive sessions. Local and remote sessions share the page total limit. Saving updates pages that are already open and can read the settings.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

**Per-session limit (MiB)** caps one session’s cached history and reading positions. **Page total limit (MiB)** caps the combined cache on one browser page. Each field takes a positive whole number, and clearing it restores the deployment default after saving. If saving fails, the form keeps your edits for you to review.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The browser companion watches the shared `session-controller` settings and forwards a complete accepted budget to the page’s Session Controller. The Plugins slot owns the editor and its drafts. The editor requires access to read the settings, and its controls require access to mutate a writable document.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session Controller](../../api/session-controller/README.md) for cache behavior.
- [Plugins](../ui-plugin-manager/README.md) for the built-in configuration cards.
- [Shared settings](../ui-settings/README.md) for the browser’s accepted settings and mutation queue.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package only sets limits on the browser’s inactive session history cache.

#### KV Cache effect

None. The cache holds browser history and reading positions.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Settings access**. The browser uses the Session Controller’s initial limits until it can read a valid configuration. If the settings later become unavailable, the page keeps its last applied budget.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
